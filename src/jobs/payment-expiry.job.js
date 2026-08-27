const cron = require('node-cron');
const Payment = require('../models/payment.model');
const logger = require('../utils/logger');
const connectDB = require('../config/db');
const mongoose = require('mongoose');

// ─── Payment Expiry logic ───────────────────────────────
const runPaymentExpiryJob = async () => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await connectDB();
    }
    const now = new Date();

    const result = await Payment.updateMany(
      {
        status: 'pending',
        expiresAt: { $lt: now },
        isVerified: false,
      },
      {
        status: 'expired',
      }
    );

    if (result.modifiedCount > 0) {
      logger.info(
        `[Cron] Payment expiry: ${result.modifiedCount} payments marked as expired`
      );
    }
    return result.modifiedCount;
  } catch (err) {
    logger.warn(`[Cron] Payment expiry job warning: ${err.message}`);
    return 0;
  }
};

const initPaymentExpiryJob = () => {
  logger.info('[Cron] Starting payment expiry cleanup job...');

  // Run every 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    await runPaymentExpiryJob();
  });

  logger.info('[Cron] Payment expiry job scheduled (every 10 minutes)');
};

module.exports = initPaymentExpiryJob;
module.exports.runPaymentExpiryJob = runPaymentExpiryJob;
