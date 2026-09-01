const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
require('dotenv').config({ path: require('path').resolve(__dirname, '..', envFile) });
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const mongoose = require('mongoose');
const compression = require('compression');

// ── Security middlewares ───────────────────────────────────
let mongoSanitize, hpp;
try { mongoSanitize = require('./utils/mongoSanitize'); } catch { try { mongoSanitize = require('express-mongo-sanitize'); } catch { } }
try { hpp = require('hpp'); } catch { }

// Custom XSS sanitizer compatible with Express v5
const xssClean = (() => {
  const escapeHtml = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  };
  const sanitize = (val) => {
    if (typeof val === 'string') return escapeHtml(val);
    if (Array.isArray(val)) return val.map(sanitize);
    if (val && typeof val === 'object') {
      const out = {};
      for (const k of Object.keys(val)) out[k] = sanitize(val[k]);
      return out;
    }
    return val;
  };
  return () => (req, _res, next) => {
    if (req.body) req.body = sanitize(req.body);
    if (req.params) req.params = sanitize(req.params);
    if (req.query) {
      for (const k of Object.keys(req.query)) {
        try { req.query[k] = sanitize(req.query[k]); } catch (_) { }
      }
    }
    next();
  };
})();

// ── Core utils ─────────────────────────────────────────────
const logger = require('./utils/logger');
const connectDB = require('./config/db');
const initSocket = require('./config/socket');
const { connectRedis } = require('./config/redis');
const { setupSwagger } = require('./docs/swagger');
const errorMiddleware = require('./middlewares/error.middleware');
const requestLogger = require('./middlewares/requestLogger.middleware');
const { globalLimiter, authLimiter } = require('./middlewares/advancedRateLimit.middleware');
const { i18next, i18nMiddleware } = require('./config/i18n');

// ── Jobs ────────────────────────────────────────────────────

const { initSavedSearchJob } = require('./jobs/savedSearch.job');
const { initBookingJob } = require('./jobs/booking.job');
const initPaymentExpiryJob = require('./jobs/payment-expiry.job');
const { initSubscriptionExpiryJob } = require('./jobs/subscription-expiry.job');
const { initKycCleanupJob } = require('./jobs/kyc-cleanup.job');
// ── Routes ──────────────────────────────────────────────────
const authRoutes = require('./routes/auth.routes');
const userRoutes = require('./routes/user.routes');
const propertyRoutes = require('./routes/property.routes');
const reviewRoutes = require('./routes/review.routes');
const favoriteRoutes = require('./routes/favorite.routes');
const bookingRoutes = require('./routes/booking.routes');
const paymentRoutes = require('./routes/payment.routes');
const inquiryRoutes = require('./routes/inquiry.routes');
const viewingRequestRoutes = require('./routes/viewingRequest.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const notificationRoutes = require('./routes/notification.routes');
const searchRoutes = require('./routes/search.routes');
const reportRoutes = require('./routes/report.routes');
const subscriptionRoutes = require('./routes/subscription.routes');
const healthRoutes = require('./routes/health.routes');
const kycRoutes = require('./routes/kyc.routes');
const auctionRoutes = require('./routes/auction.routes');
const bidRoutes = require('./routes/bid.routes');
const agentRoutes = require('./routes/agent.routes');
const chatRoutes = require('./routes/chat.routes');
const jobsRoutes = require('./routes/jobs.routes');
const CLIENT_URL = process.env.CLIENT_URL;

if (!CLIENT_URL) {
  throw new Error('CLIENT_URL is required in .env');
}

// ── BUG-03 FIX: Multi-origin CORS ─────────────────────────────
// ALLOWED_ORIGINS is a comma-separated list in .env.
// Falls back to CLIENT_URL for single-origin setups.
// Example: ALLOWED_ORIGINS=http://localhost:4200,https://luxe-estates.vercel.app
const allowedOrigins = [
  'http://localhost:4200',
  'https://aqario-luxe.vercel.app', // Core production domain
  'https://luxe-estates.vercel.app',
  'https://www.aqarioluxe.com',
  'https://aqarioluxe.com'
];

if (process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean).forEach(origin => {
    if (!allowedOrigins.includes(origin)) {
      allowedOrigins.push(origin);
    }
  });
}
if (CLIENT_URL && !allowedOrigins.includes(CLIENT_URL)) {
  allowedOrigins.push(CLIENT_URL);
}

// ── App Setup ──────────────────────────────────────────────
const app = express();

// CRUCIAL: Enable trust proxy for live cloud deployments (Railway/Render/AWS)
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = initSocket(server);

// ── CORS FIRST — Before all other middleware ──────────────────
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false); // Deny CORS cleanly without throwing a 500 error
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
  exposedHeaders: ['X-Request-Id'],
  optionsSuccessStatus: 200 // Response status for preflight OPTIONS requests
};

app.use(cors(corsOptions));
app.options(/(.*)/, cors(corsOptions)); // Handle preflight OPTIONS requests explicitly for all routes using RegExp for Express v5 compatibility


// ── Middlewares ────────────────────────────────────────────
// Lazy database and services connection middleware for Serverless compatibility
let servicesConnected = false;
const connectServices = async () => {
  if (!servicesConnected) {
    await connectDB();
    await connectRedis();
    servicesConnected = true;
  }
};

app.use(async (req, res, next) => {
  if (process.env.NODE_ENV === 'test') {
    return next();
  }
  try {
    await connectServices();
    next();
  } catch (err) {
    logger.error('Failed to connect to services on demand:', err.message);
    next(err);
  }
});

app.use(requestLogger);
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc:     ["'self'", 'data:', 'https://res.cloudinary.com', 'https://lh3.googleusercontent.com', 'https://*.googleusercontent.com', 'blob:'],
      scriptSrc:  ["'self'", 'https://accounts.google.com'],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
      connectSrc: ["'self'", CLIENT_URL, ...allowedOrigins, 'https://accounts.google.com', 'https://oauth2.googleapis.com', 'https://www.googleapis.com'],
      frameSrc:   ["'self'", 'https://accounts.google.com', 'https://content-autofill.googleapis.com'],
      objectSrc:  ["'none'"],
    },
  },
  // Required for Google Sign-In popup flow:
  // 'same-origin-allow-popups' lets the OAuth popup call window.postMessage
  // back to the opener. Setting this to false entirely silences the COOP
  // header but leaves the app unprotected; the correct value is below.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  crossOriginEmbedderPolicy: false,
}));

// Body parsing
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (mongoSanitize) app.use(mongoSanitize());
if (xssClean) app.use(xssClean());
if (hpp) app.use(hpp({ whitelist: ['price', 'bedrooms', 'bathrooms', 'area'] }));

// i18n — language detection via Accept-Language header
app.use(i18nMiddleware.handle(i18next));

// Rate limiting (disabled in tests to allow fast test execution without lockouts)
if (process.env.NODE_ENV !== 'test') {
  app.use('/api', globalLimiter);
  app.use('/api/v1/auth', authLimiter); // BUG-02 FIX: Re-enabled — was disabled during Google login testing
}

// Cookie parsing (must be before routes that use cookies)
app.use(cookieParser());

// Attach io to requests
app.use((req, _res, next) => { req.io = io; next(); });

// Static files with 1-year aggressive browser caching for instant asset loading
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads'), {
  maxAge: '1y',
  etag: true,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

// Swagger docs
if (process.env.NODE_ENV !== 'production') setupSwagger(app);

// ── API Routes ─────────────────────────────────────────────
const API = '/api/v1';
app.use('/api/health', healthRoutes);
app.use(`${API}/auth`, authRoutes);
app.use(`${API}/users`, userRoutes);
app.use(`${API}/kyc`, kycRoutes);
app.use(`${API}/properties`, propertyRoutes);
app.use(`${API}/search`, searchRoutes);
app.use(`${API}/reviews`, reviewRoutes);
app.use(`${API}/favorites`, favoriteRoutes);
app.use(`${API}/bookings`, bookingRoutes);
app.use(`${API}/payments`, paymentRoutes);
app.use(`${API}/inquiries`, inquiryRoutes);
app.use(`${API}/viewing-requests`, viewingRequestRoutes);
app.use(`${API}/dashboard`, dashboardRoutes);
app.use(`${API}/notifications`, notificationRoutes);
app.use(`${API}/reports`, reportRoutes);
app.use(`${API}/subscriptions`, subscriptionRoutes);
app.use(`${API}/auctions`, auctionRoutes);
app.use(`${API}/bids`, bidRoutes);
app.use(`${API}/agents`, agentRoutes);
app.use(`${API}/chats`, chatRoutes);
app.use(`${API}/jobs`, jobsRoutes);

// Root
app.get('/', (req, res) => res.json({
  status: 'success',
  message: ' Real Estate Pro API',
  version: '4.0.0',
  docs: `${req.protocol}://${req.get('host')}/api/docs`,
  health: `${req.protocol}://${req.get('host')}/api/health`,
}));

// 404
app.use((req, res) => {
  res.status(404).json({
    status: 'fail',
    message: req.t('COMMON.PATH_NOT_FOUND', { path: req.originalUrl }),
  });
});
// Global Error Handler
app.use(errorMiddleware);

// Graceful shutdown
const shutdown = async (signal) => {
  logger.info(`${signal} — graceful shutdown...`);
  server.close(async () => {
    await mongoose.connection.close(false);
    logger.info('MongoDB connection closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
};
['SIGTERM', 'SIGINT', 'SIGUSR2'].forEach(sig => process.on(sig, () => shutdown(sig)));
process.on('unhandledRejection', (err) => { logger.error('Unhandled Rejection:', err.message); logger.error(err.stack); shutdown('unhandledRejection'); });
process.on('uncaughtException', (err) => { logger.error('Uncaught Exception:', err.message); logger.error(err.stack); shutdown('uncaughtException'); });

// Start Server
const PORT = process.env.PORT || 3000;
const startServer = async () => {
  await connectDB();
  await connectRedis();
  servicesConnected = true;
  server.listen(PORT, () => {
    logger.info(` Server running on port ${PORT}`);
    logger.info(` API: http://localhost:${PORT}${API}`);
    logger.info(` Docs: http://localhost:${PORT}/api/docs`);
    logger.info(`  Health: http://localhost:${PORT}/api/health`);
    
    // In-memory crons are disabled on Vercel to avoid multiple running instances
    if (!process.env.VERCEL) {
      initSavedSearchJob(io);
      initBookingJob(io);
      initPaymentExpiryJob();
      initSubscriptionExpiryJob();
      initKycCleanupJob();
    }

    // Programmatically initialize localtunnel in development
    if (process.env.NODE_ENV === 'development') {
      try {
        const localtunnel = require('localtunnel');
        (async () => {
          try {
            const tunnel = await localtunnel({ port: PORT, subdomain: 'aqario-luxe-eslam' });
            console.log(`[Localtunnel] Tunnel active at: ${tunnel.url}`);

            tunnel.on('close', () => {
              console.log('[Localtunnel] Tunnel has closed cleanly.');
            });
          } catch (tunnelErr) {
            console.error('[Localtunnel] Failed to initialize tunnel:', tunnelErr.message);
          }
        })();
      } catch (requireErr) {
        console.error('[Localtunnel] localtunnel package load failed:', requireErr.message);
      }
    }
  });
};

const isVercel = process.env.VERCEL === '1';

if (process.env.NODE_ENV !== 'test' && !isVercel) {
  startServer().catch((err) => {
    logger.error('Startup failed:', err.message);
    logger.error(err.stack);
    process.exit(1);
  });
}

module.exports = app;
module.exports.app = app;
module.exports.io = io;
module.exports.startServer = startServer;
