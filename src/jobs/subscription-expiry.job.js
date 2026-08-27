// ──────────────────────────────────────────────────────────
// Subscription Expiry Job
// ──────────────────────────────────────────────────────────
// Cron 1: Daily at 00:30 — expire overdue subscriptions
//         Updates Subscription.status → 'expired'
//         Updates User.subscriptionStatus → 'expired'
//         Clears User.activeSubscription
//
// Cron 2: Monthly on the 1st at 00:05 — reset monthly usage
//         Resets Subscription.listingsUsedThisMonth → 0
//         Updates Subscription.lastResetAt → now
// ──────────────────────────────────────────────────────────

const cron         = require('node-cron');
const Subscription = require('../models/subscription.model');
const User         = require('../models/user.model');
const logger       = require('../utils/logger');
const connectDB    = require('../config/db');
const mongoose     = require('mongoose');

// ── Daily: expire overdue subscriptions ──────────────────────────────────────
const expireSubscriptions = async () => {
  try {
    if (mongoose.connection.readyState !== 1) {
      await connectDB();
    }
    const now = new Date();

    // Find all active subscriptions whose endDate has passed
    const expired = await Subscription.find({
      status:  'active',
      endDate: { $lt: now },
    }).select('_id user plan endDate').lean();

    if (!expired.length) {
      logger.info('[SubExpiry] No subscriptions to expire.');
      return;
    }

    const expiredIds = expired.map(s => s._id);
    const userIds    = expired.map(s => s.user);

    // Bulk-update subscriptions → expired
    await Subscription.updateMany(
      { _id: { $in: expiredIds } },
      { $set: { status: 'expired' } }
    );

    // Bulk-update users → clear activeSubscription + set status expired
    await User.updateMany(
      { activeSubscription: { $in: expiredIds } },
      { $set: { subscriptionStatus: 'expired', activeSubscription: null } }
    );

    logger.info(
      `[SubExpiry] ✅ Expired ${expired.length} subscription(s) for users: [${userIds.join(', ')}]`
    );
  } catch (err) {
    logger.error(`[SubExpiry] ❌ Error during expiry run: ${err.message}`);
    logger.error(err.stack);
  }
};

// ── Monthly: reset listing usage counter ─────────────────────────────────────
const resetMonthlyUsage = async () => {
  try {
    const result = await Subscription.updateMany(
      { status: 'active' },
      {
        $set: {
          listingsUsedThisMonth: 0,
          lastResetAt: new Date(),
        },
      }
    );

    logger.info(`[SubExpiry] 🔄 Monthly reset: cleared listingsUsedThisMonth for ${result.modifiedCount} active subscription(s).`);
  } catch (err) {
    logger.error(`[SubExpiry] ❌ Error during monthly reset: ${err.message}`);
    logger.error(err.stack);
  }
};

// ── Init ─────────────────────────────────────────────────────────────────────
const initSubscriptionExpiryJob = () => {
  // Daily at 00:30 — expire subscriptions
  cron.schedule('30 0 * * *', async () => {
    logger.info('[SubExpiry] ⏰ Running daily subscription expiry check...');
    await expireSubscriptions();
  });

  // 1st of every month at 00:05 — reset monthly listing counts
  cron.schedule('5 0 1 * *', async () => {
    logger.info('[SubExpiry] 🔄 Running monthly listing usage reset...');
    await resetMonthlyUsage();
  });

  logger.info('[SubExpiry] ✅ Subscription expiry job → daily 00:30 | Monthly reset → 1st at 00:05');
};

module.exports = { initSubscriptionExpiryJob, expireSubscriptions, resetMonthlyUsage };
