const mongoose  = require('mongoose');
const User      = require('../../models/user.model');
const Property  = require('../../models/property.model');
const Booking   = require('../../models/booking.model');
const Payment   = require('../../models/payment.model');
const Favorite  = require('../../models/favorite.model');
const Inquiry   = require('../../models/inquiry.model');
const Review    = require('../../models/review.model');
const Subscription = require('../../models/subscription.model');
const ExcelJS = require('exceljs');
const { PAYMENT_STATUS, SUBSCRIPTION_STATUS } = require('../../utils/constants');
const { logAction, getAuditLogs: fetchAuditLogs } = require('../../services/audit.service');
const asyncHandler = require('../../utils/asyncHandler');
const { getPaginationParams } = require('../../utils/paginate');

// ══════════════════════════════════════════════════════
//  ADMIN DASHBOARD
// ══════════════════════════════════════════════════════

// @route GET /api/v1/dashboard/admin/requests
exports.adminPropertyRequests = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 15;
  const skip = (page - 1) * limit;

  const filter = {
    $or: [
      { type: 'property_submission' },
      { 'details.contactName': { $exists: true, $ne: null } },
      { 'details.propertyType': { $exists: true, $ne: null } }
    ]
  };

  if (req.query.status && req.query.status !== 'all') {
    filter.status = req.query.status;
  }

  if (req.query.search) {
    const searchRegex = new RegExp(req.query.search, 'i');
    filter.$and = [
      {
        $or: [
          { 'details.contactName': searchRegex },
          { 'details.contactPhone': searchRegex },
          { 'details.city': searchRegex },
          { content: searchRegex }
        ]
      }
    ];
  }

  const total = await Inquiry.countDocuments(filter);
  const requests = await Inquiry.find(filter)
    .populate('sender', 'name email photo phone')
    .sort('-createdAt')
    .skip(skip)
    .limit(limit);

  res.status(200).json({
    status: 'success',
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
    data: { requests }
  });
});

// @route GET /api/v1/dashboard/admin/stats
exports.adminStats = asyncHandler(async (req, res) => {
  const [
    totalUsers,
    totalProperties,
    totalBookings,
    pendingKyc,
    paymentRevenue,
    subscriptionRevenue,
    activeSubscriptions,
  ] = await Promise.all([
    User.countDocuments(),
    Property.countDocuments(),
    Booking.countDocuments(),
    User.countDocuments({ kycStatus: 'pending' }),
    // Revenue from property payments (platform commission)
    Payment.aggregate([
      { $match: { status: PAYMENT_STATUS.PAID } },
      { $group: { _id: null, total: { $sum: '$totalAmount' }, platformFees: { $sum: '$platformFee' } } },
    ]),
    // Revenue from subscriptions
    Subscription.aggregate([
      { $match: { status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.EXPIRED] } } },
      { $group: { _id: null, total: { $sum: '$price' }, count: { $sum: 1 } } },
    ]),
    // Count active subscriptions
    Subscription.countDocuments({ status: SUBSCRIPTION_STATUS.ACTIVE }),
  ]);

  const totalSubRevenue = subscriptionRevenue[0]?.total || 0;
  const totalPlatformFees = paymentRevenue[0]?.platformFees || 0;

  res.status(200).json({
    status: 'success',
    data: {
      totalUsers,
      totalProperties,
      totalBookings,
      pendingKyc,
      // Detailed revenue
      propertyTotal:       paymentRevenue[0]?.total       || 0,
      platformFees:        totalPlatformFees,
      subscriptionRevenue: totalSubRevenue,
      subscriptionCount:   subscriptionRevenue[0]?.count || 0,
      activeSubscriptions,
      // The main KPI value for the dashboard
      totalRevenue:        totalPlatformFees + totalSubRevenue,
    },
  });
});

// @route GET /api/v1/dashboard/admin/activity
exports.adminActivity = asyncHandler(async (req, res) => {
  let queryLimit = req.query.limit;
  if (Array.isArray(queryLimit)) queryLimit = queryLimit[0];
  const limit = Math.max(1, Math.min(100, parseInt(queryLimit, 10) || 10));
  
  // Optimized Aggregation Pipeline using $unionWith to fetch and normalize global events
  const activities = await User.aggregate([
    // 1. Process recent Users
    { $sort: { createdAt: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        entityId: '$_id',
        type: 'USER_REGISTERED',
        message: { $concat: ['New user registered: ', '$name'] },
        messageAr: { $concat: ['تم تسجيل مستخدم جديد: ', '$name'] },
        createdAt: 1,
        colorCode: 'blue'
      }
    },
    // 2. Union with recent Properties
    {
      $unionWith: {
        coll: 'properties',
        pipeline: [
          { $sort: { createdAt: -1 } },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              entityId: '$_id',
              type: 'NEW_LISTING',
              message: { $concat: ['New property listed: ', '$title.en'] },
              messageAr: { $concat: ['تم إدراج عقار جديد: ', { $ifNull: ['$title.ar', '$title.en'] }] },
              createdAt: 1,
              colorCode: 'purple'
            }
          }
        ]
      }
    },
    // 3. Union with recent Bookings
    {
      $unionWith: {
        coll: 'bookings',
        pipeline: [
          { $sort: { created_at: -1 } },
          { $limit: limit },
          // Join with property to get title
          {
            $lookup: {
              from: 'properties',
              localField: 'property_id',
              foreignField: '_id',
              as: 'property'
            }
          },
          { $unwind: { path: '$property', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 0,
              entityId: '$_id',
              type: 'NEW_BOOKING',
              message: { 
                $cond: {
                  if: { $gt: [{ $strLenCP: { $ifNull: ['$property.title.en', ''] } }, 0] },
                  then: { $concat: ['New booking for: ', '$property.title.en'] },
                  else: 'New booking reservation created.'
                }
              },
              messageAr: {
                $cond: {
                  if: { $gt: [{ $strLenCP: { $ifNull: [{ $ifNull: ['$property.title.ar', '$property.title.en'] }, ''] } }, 0] },
                  then: { $concat: ['حجز جديد لـ: ', { $ifNull: ['$property.title.ar', '$property.title.en'] }] },
                  else: 'تم إنشاء حجز جديد.'
                }
              },
              createdAt: '$created_at',
              colorCode: 'gold'
            }
          }
        ]
      }
    },
    // 4. Sort the combined stream globally
    { $sort: { createdAt: -1 } },
    // 5. Final output limit
    { $limit: limit }
  ]);

  res.status(200).json({ status: 'success', data: { activities } });
});

// @route GET /api/v1/dashboard/admin/users
exports.recentUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPaginationParams(req.query);
  const { search, role, status } = req.query;

  const filter = {};

  // 1️⃣ Multi-word Search (case-insensitive, partial match)
  if (search) {
    const searchTerms = search.trim().split(/\s+/);
    filter.$and = searchTerms.map(term => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return {
        $or: [
          { name: { $regex: escaped, $options: 'i' } },
          { email: { $regex: escaped, $options: 'i' } }
        ]
      };
    });
  }

  // Filter by role
  const validRoles = ['buyer', 'owner', 'agent', 'admin'];
  if (role && validRoles.includes(role)) {
    filter.role = role;
  }

  // Filter by status: active | banned
  if (status === 'banned')  filter.isBanned = true;
  if (status === 'active')  filter.isBanned = false;

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort('-createdAt')
      .skip(skip)
      .limit(limit)
      .select('name email role createdAt isActive isBanned isVerified kycStatus photo')
      .lean(),
    User.countDocuments(filter),
  ]);

  res.status(200).json({
    status: 'success',
    page,
    total,
    pages: Math.ceil(total / limit),
    results: users.length,
    data: { users },
  });
});

// @route GET /api/v1/dashboard/admin/users/export
exports.exportUsers = asyncHandler(async (req, res, next) => {
  const { search, role, status } = req.query;
  const filter = {};

  if (search) {
    const searchTerms = search.trim().split(/\s+/);
    filter.$and = searchTerms.map(term => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return {
        $or: [
          { name: { $regex: escaped, $options: 'i' } },
          { email: { $regex: escaped, $options: 'i' } }
        ]
      };
    });
  }

  const validRoles = ['buyer', 'owner', 'agent', 'admin'];
  if (role && validRoles.includes(role)) {
    filter.role = role;
  }

  if (status === 'banned')  filter.isBanned = true;
  if (status === 'active')  filter.isBanned = false;

  const users = await User.find(filter)
    .sort('-createdAt')
    .lean();

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Users');

  worksheet.columns = [
    { header: 'User ID', key: '_id', width: 26 },
    { header: 'Name', key: 'name', width: 25 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Role', key: 'role', width: 15 },
    { header: 'KYC Status', key: 'kycStatus', width: 18 },
    { header: 'Banned', key: 'isBanned', width: 12 },
    { header: 'Registration Date', key: 'createdAt', width: 25 }
  ];

  users.forEach(u => {
    worksheet.addRow({
      _id: u._id.toString(),
      name: u.name,
      email: u.email,
      role: u.role,
      kycStatus: u.kycStatus || 'not_submitted',
      isBanned: u.isBanned ? 'Yes' : 'No',
      createdAt: u.createdAt ? u.createdAt.toISOString() : 'N/A'
    });
  });

  const headerRow = worksheet.getRow(1);
  headerRow.height = 24;
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F4E78' }
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) {
      row.getCell('role').alignment = { horizontal: 'center' };
      row.getCell('kycStatus').alignment = { horizontal: 'center' };
      row.getCell('isBanned').alignment = { horizontal: 'center' };
    }
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=users-export-${Date.now()}.xlsx`);

  await workbook.xlsx.write(res);
  res.end();
});

// @route GET /api/v1/dashboard/admin/bookings
exports.recentBookings = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPaginationParams(req.query);
  const { search, status } = req.query;

  const filter = {};

  // 1. Filter by Status
  if (status && status !== 'all') {
    filter.status = status;
  }

  // 2. Search by Client Name, Email or Property Title
  if (search && search.trim() !== '') {
    const searchRegex = { $regex: search.trim(), $options: 'i' };
    
    // Find matching users and properties to get their IDs
    const [users, properties] = await Promise.all([
      User.find({ $or: [{ name: searchRegex }, { email: searchRegex }] }).select('_id'),
      Property.find({ $or: [{ 'title.en': searchRegex }, { 'title.ar': searchRegex }] }).select('_id')
    ]);

    const userIds = users.map(u => u._id);
    const propertyIds = properties.map(p => p._id);

    filter.$or = [
      { user_id: { $in: userIds } },
      { property_id: { $in: propertyIds } }
    ];
  }

  const [bookings, total] = await Promise.all([
    Booking.find(filter)
      .sort('-created_at')
      .skip(skip)
      .limit(limit)
      .populate('user_id', 'name email photo')
      .populate('property_id', 'title price location images owner')
      .lean(),
    Booking.countDocuments(filter)
  ]);

  // Attach payment info for each booking
  const bookingsWithPayments = await Promise.all(bookings.map(async (b) => {
    const payment = await Payment.findOne({ booking: b._id }).select('status paymentMethod totalAmount createdAt');
    return { ...b, payment };
  }));

  res.status(200).json({
    status: 'success',
    page,
    total,
    pages: Math.ceil(total / limit),
    results: bookings.length,
    data: { bookings: bookingsWithPayments }
  });
});

// @route GET /api/v1/dashboard/admin/payments
exports.recentPayments = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPaginationParams(req.query);
  
  // Populate nested fields to satisfy the dashboard UI mapping
  const [rawPayments, total] = await Promise.all([
    Payment.find()
      .sort('-createdAt')
      .skip(skip)
      .limit(limit)
      .populate('user', 'name email photo')
      .populate({
        path: 'booking',
        select: 'property_id amount start_date end_date',
        populate: { path: 'property_id', select: 'title' }
      })
      .populate('property', 'title') // Fallback if booking is missing
      .lean(),
    Payment.countDocuments()
  ]);

  // Map to the shape expected by TransactionsTableComponent
  const payments = rawPayments.map(p => ({
    ...p,
    user_id: p.user, // Alias for frontend
    booking_id: p.booking, // Alias for frontend
    amount: p.totalAmount, // Map totalAmount to amount
  }));

  res.status(200).json({ 
    status: 'success', 
    page, 
    total, 
    pages: Math.ceil(total / limit), 
    results: payments.length, 
    data: { payments } 
  });
});

// @route GET /api/v1/dashboard/admin/properties
exports.recentProperties = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPaginationParams(req.query);
  const { search, type, isApproved, status, priceRange } = req.query;

  const filter = {};

  // 1. Search by title OR Owner Name
  if (search && search.trim() !== '') {
    const searchRegex = { $regex: search.trim(), $options: 'i' };
    
    // Find users matching the search string to search by owner name
    const matchingUsers = await User.find({ name: searchRegex }).select('_id');
    const ownerIds = matchingUsers.map(u => u._id);

    filter.$or = [
      { 'title.en': searchRegex },
      { 'title.ar': searchRegex },
      { owner: { $in: ownerIds } }
    ];
  }

  // 2. Filter by type (villa, apartment, etc)
  if (type && type !== 'all') {
    filter.type = type;
  }

  // 3. Filter by approval status
  if (isApproved === 'true')  filter.isApproved = true;
  if (isApproved === 'false') filter.isApproved = { $ne: true };

  // 4. Filter by listing status (available, reserved, sold)
  if (status && status !== 'all') {
    filter.status = status;
  }

  // 5. Filter by price range
  if (priceRange === 'low')    filter.price = { $lt: 500000 };
  if (priceRange === 'medium') filter.price = { $gte: 500000, $lte: 5000000 };
  if (priceRange === 'high')   filter.price = { $gt: 5000000 };

  const [properties, total] = await Promise.all([
    Property.find(filter)
      .sort('-createdAt')
      .skip(skip)
      .limit(limit)
      .populate('owner', 'name email')
      .lean(),
    Property.countDocuments(filter),
  ]);

  const mappedProperties = properties.map(p => ({
    ...p,
    approvalStatus: p.isApproved ? 'approved' : 'pending'
  }));

  res.status(200).json({
    status: 'success',
    page,
    total,
    pages: Math.ceil(total / limit),
    results: mappedProperties.length,
    data: { properties: mappedProperties },
  });
});

// ── Admin Management ──────────────────────────────────────────

// @route PATCH /api/v1/dashboard/admin/users/:id/role
exports.changeUserRole = asyncHandler(async (req, res) => {
  // 1) Prevent self-modification
  if (req.user.id === req.params.id) {
    return res.status(403).json({ status: 'fail', message: 'You cannot modify your own role.' });
  }

  const { role } = req.body;
  const validRoles = ['buyer', 'owner', 'agent']; // 'admin' is intentionally excluded
  if (!validRoles.includes(role)) {
    return res.status(400).json({
      status: 'fail',
      message: `Invalid role. Allowed values: ${validRoles.join(', ')}. Admin role cannot be assigned this way.`
    });
  }
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ status: 'fail', message: req.t('DASHBOARD.USER_NOT_FOUND') });
  
  // 2) Prevent downgrading other admins
  if (user.role === 'admin') {
    return res.status(403).json({ status: 'fail', message: 'You cannot downgrade another admin.' });
  }

  const prevRole = user.role;
  user.role = role;
  await user.save();

  // ── Audit Trail ──────────────────────────────────────────────
  await logAction(
    req.user._id, 'CHANGE_ROLE', 'User', user._id,
    { before: { role: prevRole }, after: { role } },
    { ip: req.ip, userAgent: req.headers['user-agent'] }
  );

  res.status(200).json({ status: 'success', message: req.t('DASHBOARD.ROLE_UPDATED'), data: { user } });
});

// @route PATCH /api/v1/dashboard/admin/users/:id/ban
exports.toggleBanUser = asyncHandler(async (req, res) => {
  const useTransaction = process.env.NODE_ENV === 'production';
  const session = useTransaction ? await mongoose.startSession() : null;
  if (session) session.startTransaction();

  try {
    // Prevent self-banning
    if (req.user.id === req.params.id) {
      if (session) await session.abortTransaction();
      return res.status(403).json({ status: 'fail', message: 'You cannot ban your own account.' });
    }

    const user = await User.findById(req.params.id).session(session);
    if (!user) {
      if (session) await session.abortTransaction();
      return res.status(404).json({ status: 'fail', message: req.t('DASHBOARD.USER_NOT_FOUND') });
    }

    // Prevent banning admins
    if (user.role === 'admin') {
      if (session) await session.abortTransaction();
      return res.status(403).json({ status: 'fail', message: 'Admin accounts cannot be banned.' });
    }

    const wasBanned = user.isBanned;
    user.isBanned = !user.isBanned;
    user.isActive = !user.isBanned;
    await user.save({ session });

    // ── Audit Trail ──────────────────────────────────────────────
    const banAction = user.isBanned ? 'BAN_USER' : 'UNBAN_USER';
    await logAction(
      req.user._id, banAction, 'User', user._id,
      { before: { isBanned: wasBanned }, after: { isBanned: user.isBanned } },
      { ip: req.ip, userAgent: req.headers['user-agent'], session }
    );

    if (session) await session.commitTransaction();
    res.status(200).json({
      status: 'success',
      message: user.isBanned ? req.t('DASHBOARD.USER_BANNED') : req.t('DASHBOARD.USER_UNBANNED'),
      data: { user },
    });
  } catch (err) {
    if (session) await session.abortTransaction();
    throw err;
  } finally {
    if (session) session.endSession();
  }
});

// @route PATCH /api/v1/dashboard/admin/properties/:id/approve
exports.approveProperty = asyncHandler(async (req, res) => {
  const useTransaction = process.env.NODE_ENV === 'production';
  const session = useTransaction ? await mongoose.startSession() : null;
  if (session) session.startTransaction();

  try {
    const existing = await Property.findById(req.params.id).session(session);
    if (!existing) {
      if (session) await session.abortTransaction();
      return res.status(404).json({ status: 'fail', message: 'Property not found' });
    }

    // Business Guard
    if (existing.isApproved) {
      if (session) await session.abortTransaction();
      return res.status(400).json({ status: 'fail', message: 'Property is already approved.' });
    }

    const updated = await Property.findByIdAndUpdate(
      req.params.id,
      { isApproved: true, status: 'available' },
      { new: true, session }
    ).populate('owner', 'name email').lean();

    if (!updated) {
      if (session) await session.abortTransaction();
      return res.status(404).json({ status: 'fail', message: 'Property not found' });
    }

    // Explicitly add approvalStatus for frontend mapping
    updated.approvalStatus = 'approved';

    // ── Audit Trail ──────────────────────────────────────────────
    await logAction(
      req.user._id, 'APPROVE_PROPERTY', 'Property', updated._id,
      { before: { isApproved: false, status: existing.status }, after: { isApproved: true, status: 'available' } },
      { ip: req.ip, userAgent: req.headers['user-agent'], session }
    );

    if (session) await session.commitTransaction();
    res.status(200).json({ status: 'success', data: { property: updated } });
  } catch (err) {
    if (session) await session.abortTransaction();
    throw err;
  } finally {
    if (session) session.endSession();
  }
});

// @route PATCH /api/v1/dashboard/admin/properties/:id/reject
exports.rejectProperty = asyncHandler(async (req, res) => {
  const useTransaction = process.env.NODE_ENV === 'production';
  const session = useTransaction ? await mongoose.startSession() : null;
  if (session) session.startTransaction();

  try {
    const existing = await Property.findById(req.params.id).session(session);
    if (!existing) {
      if (session) await session.abortTransaction();
      return res.status(404).json({ status: 'fail', message: 'Property not found' });
    }

    // Business Guard
    if (!existing.isApproved && existing.status === 'unavailable') {
      if (session) await session.abortTransaction();
      return res.status(400).json({ status: 'fail', message: 'Property is already rejected/unavailable.' });
    }

    const prevStatus = existing.status;
    const prevApproved = existing.isApproved;

    const updated = await Property.findByIdAndUpdate(
      req.params.id,
      { isApproved: false, status: 'unavailable' },
      { new: true, session }
    ).populate('owner', 'name email').lean();

    if (!updated) {
      if (session) await session.abortTransaction();
      return res.status(404).json({ status: 'fail', message: 'Property not found' });
    }

    // Explicitly add approvalStatus for frontend mapping
    updated.approvalStatus = 'rejected';

    // ── Audit Trail ──────────────────────────────────────────────
    await logAction(
      req.user._id, 'REJECT_PROPERTY', 'Property', updated._id,
      { before: { isApproved: prevApproved, status: prevStatus }, after: { isApproved: false, status: 'unavailable' } },
      { ip: req.ip, userAgent: req.headers['user-agent'], reason: req.body.reason || null, session }
    );

    if (session) await session.commitTransaction();
    res.status(200).json({ status: 'success', data: { property: updated } });
  } catch (err) {
    if (session) await session.abortTransaction();
    throw err;
  } finally {
    if (session) session.endSession();
  }
});

// @route GET /api/v1/dashboard/admin/reports/revenue
exports.revenueReport = asyncHandler(async (req, res) => {
  const period = req.query.period || 'monthly';
  const now = new Date();
  const currentYear = now.getFullYear();

  // ── 1. Aggregate Property Payments & Subscriptions in parallel ──
  const [propertyRevenue, subscriptionRevenue] = await Promise.all([
    Payment.aggregate([
      { $match: { status: PAYMENT_STATUS.PAID } },
      {
        $group: {
          _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
          total: { $sum: '$totalAmount' }
        }
      }
    ]),
    Subscription.aggregate([
      { $match: { status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.EXPIRED] } } },
      {
        $group: {
          _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
          total: { $sum: '$price' }
        }
      }
    ])
  ]);

  // ── 3. Merge into Map ──
  const revenueMap = {};
  [...propertyRevenue, ...subscriptionRevenue].forEach(item => {
    const key = `${item._id.year}-${item._id.month}`;
    revenueMap[key] = (revenueMap[key] || 0) + item.total;
  });

  // ── 4. Generate series (Padding) ──
  const report = [];
  if (period === 'yearly') {
    // Last 5 years
    for (let i = 0; i < 5; i++) {
      const year = currentYear - (4 - i);
      
      // Sum all months for that year
      let yearlyTotal = 0;
      for (let m = 1; m <= 12; m++) {
        yearlyTotal += revenueMap[`${year}-${m}`] || 0;
      }

      report.push({
        _id: { year },
        totalRevenue: yearlyTotal
      });
    }
  } else if (period === 'quarterly') {
    // Last 4 quarters including current
    const currentQuarter = Math.floor(now.getMonth() / 3) + 1; // 1 to 4
    for (let i = 0; i < 4; i++) {
      let q = currentQuarter - (3 - i);
      let year = currentYear;
      while (q <= 0) {
        q += 4;
        year -= 1;
      }
      
      let quarterTotal = 0;
      for (let m = (q - 1) * 3 + 1; m <= q * 3; m++) {
        quarterTotal += revenueMap[`${year}-${m}`] || 0;
      }
      
      report.push({
        _id: { year, quarter: q },
        totalRevenue: quarterTotal
      });
    }
  } else {
    // Last 12 months including current
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const key = `${year}-${month}`;
      
      report.push({
        _id: { year, month },
        totalRevenue: revenueMap[key] || 0
      });
    }
  }

  res.status(200).json({ status: 'success', data: { report } });
});

// @route DELETE /api/v1/dashboard/admin/reviews/:id
exports.deleteReview = asyncHandler(async (req, res) => {
  // Use deleteOne() to trigger post('deleteOne') hook which calls calcAverageRatings
  const review = await Review.findById(req.params.id);
  if (!review) return res.status(404).json({ status: 'fail', message: req.t('DASHBOARD.REVIEW_NOT_FOUND') });

  const snapshot = { userId: review.userId, propertyId: review.propertyId, rating: review.rating };
  await review.deleteOne();

  // ── Audit Trail ──────────────────────────────────────────────
  await logAction(
    req.user._id, 'DELETE_REVIEW', 'Review', req.params.id,
    { before: snapshot, after: null },
    { ip: req.ip, userAgent: req.headers['user-agent'], reason: req.body.reason || null }
  );

  res.status(200).json({ status: 'success', message: req.t('DASHBOARD.REVIEW_DELETED') });
});

// @route GET /api/v1/dashboard/admin/audit-logs
exports.getAuditLogs = asyncHandler(async (req, res) => {
  const result = await fetchAuditLogs(req.query);
  res.status(200).json({
    status: 'success',
    ...result,
    data: { logs: result.logs },
  });
});

// @route PATCH /api/v1/dashboard/admin/users/:id/permissions
exports.updateUserPermissions = asyncHandler(async (req, res) => {
  // Prevent self-modification of permissions
  if (req.user.id === req.params.id) {
    return res.status(403).json({ status: 'fail', message: 'You cannot modify your own permissions.' });
  }

  const { permissions } = req.body;
  if (!Array.isArray(permissions)) {
    return res.status(400).json({ status: 'fail', message: 'permissions must be an array.' });
  }

  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ status: 'fail', message: req.t('DASHBOARD.USER_NOT_FOUND') });

  if (user.role !== 'admin') {
    return res.status(400).json({ status: 'fail', message: 'Permissions can only be set on admin accounts.' });
  }

  const prevPermissions = [...(user.permissions || [])];
  user.permissions = permissions;
  await user.save();

  // ── Audit Trail ──────────────────────────────────────────────
  await logAction(
    req.user._id, 'UPDATE_PERMISSIONS', 'User', user._id,
    { before: { permissions: prevPermissions }, after: { permissions } },
    { ip: req.ip, userAgent: req.headers['user-agent'] }
  );

  res.status(200).json({
    status: 'success',
    message: 'Permissions updated successfully.',
    data: { user: { _id: user._id, name: user.name, email: user.email, permissions: user.permissions } },
  });
});

// ══════════════════════════════════════════════════════
//  OWNER DASHBOARD
// ══════════════════════════════════════════════════════

exports.ownerStats = asyncHandler(async (req, res) => {
  const myProperties = await Property.find({ owner: req.user._id }).select('_id');
  const propertyIds  = myProperties.map((p) => p._id);

  const [totalProperties, totalBookings, pendingBookings, revenue] = await Promise.all([
    Property.countDocuments({ owner: req.user._id }),
    Booking.countDocuments({ property_id: { $in: propertyIds } }),
    Booking.countDocuments({ property_id: { $in: propertyIds }, status: 'pending' }),
    Payment.aggregate([
      { $match: { status: PAYMENT_STATUS.PAID } },
      { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: 'bookingDoc' } },
      { $unwind: '$bookingDoc' },
      { $match: { 'bookingDoc.property_id': { $in: propertyIds } } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } },
    ]),
  ]);

  res.status(200).json({
    status: 'success',
    data:   { totalProperties, totalBookings, pendingBookings, revenue: revenue[0]?.total || 0 },
  });
});

exports.ownerProperties = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPaginationParams(req.query);
  const [properties, total] = await Promise.all([
    Property.find({ owner: req.user._id }).sort('-createdAt').skip(skip).limit(limit).lean(),
    Property.countDocuments({ owner: req.user._id })
  ]);
  const mappedProperties = properties.map(p => ({
    ...p,
    approvalStatus: p.isApproved ? 'approved' : 'pending'
  }));
  res.status(200).json({ status: 'success', page, total, pages: Math.ceil(total / limit), results: mappedProperties.length, data: { properties: mappedProperties } });
});

exports.ownerBookings = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPaginationParams(req.query);
  const myProperties = await Property.find({ owner: req.user._id }).select('_id');
  const propertyIds  = myProperties.map((p) => p._id);

  const [bookings, total] = await Promise.all([
    Booking.find({ property_id: { $in: propertyIds } })
      .skip(skip)
      .limit(limit)
      .populate('user_id',     'name email phone')
      .populate('property_id', 'title price location')
      .sort('-created_at')
      .lean(),
    Booking.countDocuments({ property_id: { $in: propertyIds } })
  ]);
  res.status(200).json({ status: 'success', page, total, pages: Math.ceil(total / limit), results: bookings.length, data: { bookings } });
});

// ══════════════════════════════════════════════════════
//  BUYER DASHBOARD
// ══════════════════════════════════════════════════════

exports.buyerStats = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // Parallel Execution for low latency
  const [totalBookings, activeBookings, savedProperties, spentResult] = await Promise.all([
    Booking.countDocuments({ user_id: userId }),
    Booking.countDocuments({ user_id: userId, status: { $in: ['approved', 'pending'] } }),
    Favorite.countDocuments({ user_id: userId }),
    Payment.aggregate([
      { $match: { user: new mongoose.Types.ObjectId(userId), status: PAYMENT_STATUS.PAID } },
      { $group: { _id: null, totalSpent: { $sum: '$totalAmount' } } }
    ])
  ]);

  const totalSpent = spentResult[0]?.totalSpent || 0;

  res.status(200).json({
    status: 'success',
    data: {
      totalBookings,
      activeBookings,
      savedProperties,
      totalSpent
    }
  });
});

exports.buyerBookings = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPaginationParams(req.query);
  const [bookings, total] = await Promise.all([
    Booking.find({ user_id: req.user._id })
      .skip(skip)
      .limit(limit)
      .populate('property_id', 'title price location images')
      .sort('-created_at')
      .lean(),
    Booking.countDocuments({ user_id: req.user._id })
  ]);
  res.status(200).json({ status: 'success', page, total, pages: Math.ceil(total / limit), results: bookings.length, data: { bookings } });
});

exports.buyerPayments = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPaginationParams(req.query);

  if (req.user.role === 'owner' || req.user.role === 'agent') {
    const Transaction = require('../../models/transaction.model');
    const [transactions, total] = await Promise.all([
      Transaction.find({ owner: req.user._id })
        .skip(skip)
        .limit(limit)
        .populate({
          path: 'booking',
          select: 'start_date end_date amount status'
        })
        .populate({
          path: 'property',
          select: 'title price location images'
        })
        .populate({
          path: 'payment',
          select: 'paymentMethod'
        })
        .sort('-createdAt')
        .lean(),
      Transaction.countDocuments({ owner: req.user._id })
    ]);

    // Map to shape expected by UserPaymentsComponent
    const formattedPayments = transactions.map(t => ({
      _id: t._id,
      createdAt: t.createdAt,
      property: t.property,
      booking: t.booking,
      paymentMethod: t.payment?.paymentMethod || 'card',
      totalAmount: t.netAmount, // Net earnings for the owner
      commission: t.commission,
      buyerPaid: t.amount,
      currency: t.currency || 'EGP',
      status: t.status === 'completed' ? 'paid' : t.status,
    }));

    return res.status(200).json({
      status: 'success',
      page,
      total,
      pages: Math.ceil(total / limit),
      results: formattedPayments.length,
      data: { payments: formattedPayments }
    });
  } else {
    const [payments, total] = await Promise.all([
      Payment.find({ user: req.user._id })
        .skip(skip)
        .limit(limit)
        .populate({
          path: 'booking',
          select: 'start_date end_date amount status property_id',
          populate: { path: 'property_id', select: 'title price location images' }
        })
        .sort('-createdAt')
        .lean(),
      Payment.countDocuments({ user: req.user._id })
    ]);

    res.status(200).json({ status: 'success', page, total, pages: Math.ceil(total / limit), results: payments.length, data: { payments } });
  }
});

exports.buyerFavorites = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPaginationParams(req.query);
  const [favorites, total] = await Promise.all([
    Favorite.find({ user_id: req.user._id })
      .populate('property_id')
      .skip(skip)
      .limit(limit)
      .sort('-created_at')
      .lean(),
    Favorite.countDocuments({ user_id: req.user._id })
  ]);
  res.status(200).json({ status: 'success', page, total, pages: Math.ceil(total / limit), results: favorites.length, data: { favorites } });
});

exports.activityFeed = asyncHandler(async (req, res) => {
  const limit  = 5;
  const userId = req.user._id;
  const [recentBookings, recentPayments, recentInquiries] = await Promise.all([
    Booking.find({ user_id: userId }).sort('-created_at').limit(limit).populate('property_id', 'title').lean(),
    Payment.find({ user: userId }).sort('-createdAt').limit(limit).lean(),
    Inquiry.find({ $or: [{ sender: userId }, { receiver: userId }] }).sort('-createdAt').limit(limit).populate('property', 'title').lean(),
  ]);
  res.status(200).json({ status: 'success', data: { recentBookings, recentPayments, recentInquiries } });
});
