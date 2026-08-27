const mongoose = require('mongoose');
const logger   = require('../utils/logger');

// Setup Mongoose connection event listeners for runtime connection tracking
mongoose.connection.on('connecting', () => {
  logger.info('MongoDB: Attempting connection...');
});
mongoose.connection.on('connected', () => {
  logger.info('MongoDB: Connected successfully');
});
mongoose.connection.on('disconnecting', () => {
  logger.warn('MongoDB: Disconnecting...');
});
mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB: Connection disconnected');
});
mongoose.connection.on('reconnected', () => {
  logger.info('MongoDB: Reconnected successfully');
});
mongoose.connection.on('error', (err) => {
  logger.error(`MongoDB connection event error: ${err.message}`);
});

let cachedDb = null;

const connectDB = async () => {
  if (cachedDb && mongoose.connection.readyState === 1) {
    return cachedDb;
  }
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // MongoDB Atlas recommended options for high resilience & auto-recovery
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      minPoolSize: 2,
      maxIdleTimeMS: 30000,
      heartbeatFrequencyMS: 10000,
      retryWrites: true,
      retryReads: true,
    });
    cachedDb = conn;
    logger.info(` MongoDB Atlas Connected: ${conn.connection.host}`);
  } catch (err) {
    // Gather connection and error diagnostics
    const errorDetails = {
      name: err.name,
      message: err.message,
      code: err.code,
      codeName: err.codeName,
      reason: err.reason ? (typeof err.reason === 'object' ? JSON.stringify(err.reason) : String(err.reason)) : undefined,
      readyState: mongoose.connection.readyState,
    };

    const stateNames = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    const connectionState = stateNames[errorDetails.readyState] || 'unknown';

    const logMsg = `MongoDB Connection Failed! State: ${connectionState} | Error Name: ${errorDetails.name} | Message: ${errorDetails.message} | Code: ${errorDetails.code || 'N/A'} | Reason: ${errorDetails.reason || 'N/A'}`;

    try {
      // Print clean diagnostic message directly to console
      console.error(`[DB Error Details] ${logMsg}`);
      if (err.stack) console.error(err.stack);
    } catch (_) {}

    logger.error(logMsg);
    if (err.stack) logger.error(err.stack);
    throw err;
  }
};

module.exports = connectDB;
