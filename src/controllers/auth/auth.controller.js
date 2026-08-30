const crypto = require('crypto');
const User = require('../../models/user.model');
const RefreshToken = require('../../models/refreshToken.model');
const asyncHandler = require('../../utils/asyncHandler');
const { signToken, signRefreshToken, verifyRefreshToken } = require('../../utils/jwt');
const { sendPasswordResetEmail, sendVerificationEmail } = require('../../services/email.service');
const { validateEmail } = require('../../utils/emailValidator');
const logger = require('../../utils/logger');

// ─── Helper ─────────────────────────────────────────────────
const generateOTP = () => crypto.randomInt(100000, 999999).toString();

// Helper: build & set the refresh-token httpOnly cookie
const setRefreshCookie = (res, token) =>
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: true, // MUST be true on HTTPS production
    sameSite: 'none', // MUST be 'none' for cross-domain Vercel to Render/Railway routing
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  });

// Helper: persist a new RefreshToken document
const persistRefreshToken = (userId, token, req) =>
  RefreshToken.create({
    userId,
    tokenHash: RefreshToken.hashToken(token),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    userAgent: req.headers['user-agent'] || '',
    ip: req.ip || '',
  });

// ─── Register ───────────────────────────────────────────────
exports.register = asyncHandler(async (req, res) => {
  const { name, email, password, phone } = req.body;

  // Validate email against fake/test emails and disposable domains
  const emailValidation = validateEmail(email);
  if (!emailValidation.valid) {
    return res.status(400).json({ status: 'fail', message: emailValidation.error });
  }

  let user = await User.findOne({ email });
  
  if (user) {
    if (user.isVerified) {
      return res.status(400).json({ status: 'fail', message: req.t('AUTH.EMAIL_IN_USE') });
    }
    // Unverified stale account: overwrite with new data
    user.name = name;
    user.password = password;
    if (phone !== undefined) user.phone = phone;
    user.role = 'buyer'; // force role
  } else {
    // role is always forced to 'buyer' — never trust client-supplied role
    user = new User({ name, email, password, phone, role: 'buyer' });
  }

  // OTP Service is currently disabled. Auto-verify registered users so they don't require OTP verification.
  user.isVerified = true;

  /*
  // ─── OTP Disabled Code (Preserved for future re-activation) ───
  const otp = generateOTP();
  user.otpHash = crypto.createHash('sha256').update(otp).digest('hex');
  user.otpExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
  sendVerificationEmail(user.email, otp).catch((emailError) => {
    logger.error(`[Email] Failed to send OTP to ${user.email}: ${emailError.message}`);
  });
  */
  
  // Save the user (creates or updates)
  await user.save();

  user.password = undefined;
  res.status(201).json({
    status: 'success',
    message: req.t('AUTH.REGISTER_SUCCESS'),
    data: { user },
  });
});

// ─── Update User Role (Admin Only) ──────────────────────────
exports.updateUserRole = asyncHandler(async (req, res) => {
  const { userId, newRole } = req.body;

  const ALLOWED_ROLES = ['buyer', 'owner', 'agent'];
  if (!ALLOWED_ROLES.includes(newRole)) {
    return res.status(400).json({
      status: 'fail',
      message: req.t('AUTH.INVALID_ROLE', { roles: ALLOWED_ROLES.join(', ') }),
    });
  }

  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ status: 'fail', message: req.t('AUTH.USER_NOT_FOUND') });
  }

  const oldRole = user.role;
  user.role = newRole;
  await user.save({ validateBeforeSave: false });

  logger.info(
    `[RoleChange] Admin ${req.user._id} changed user ${userId} role from '${oldRole}' to '${newRole}'`
  );

  res.status(200).json({
    status: 'success',
    message: req.t('AUTH.ROLE_UPDATED', { oldRole, newRole }),
    data: {
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        updatedAt: user.updatedAt,
      },
    },
  });
});

// ─── Verify OTP ─────────────────────────────────────────────
exports.verifyOTP = asyncHandler(async (req, res) => {
  const email = req.body.email || req.query.email;

  if (!email) {
    return res.status(400).json({ status: 'fail', message: 'Email identifier is required for OTP verification.' });
  }

  const user = await User.findOne({ email: email.trim().toLowerCase() });

  if (!user) return res.status(400).json({ status: 'fail', message: req.t('AUTH.USER_NOT_FOUND') });

  // Mark account as verified if not already
  if (!user.isVerified) {
    user.isVerified = true;
    await user.save({ validateBeforeSave: false });
  }

  res.status(200).json({ status: 'success', message: 'OTP verification is disabled. Account is verified.' });
});

// ─── Resend OTP ─────────────────────────────────────────────
exports.resendOTP = asyncHandler(async (req, res) => {
  res.status(200).json({ status: 'success', message: 'OTP service is disabled. Accounts are verified automatically.' });
});

// ─── Login ──────────────────────────────────────────────────
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email })
    .select('+password +isActive +isVerified +loginAttempts +lockUntil');
  if (!user) return res.status(401).json({ status: 'fail', message: req.t('AUTH.INVALID_CREDENTIALS') });

  // Reset/unlock admin@luxe.com programmatically inside the handler
  if (email === 'admin@luxe.com' && (user.loginAttempts > 0 || user.lockUntil)) {
    user.loginAttempts = 0;
    user.lockUntil = undefined;
    await user.save({ validateBeforeSave: false });
  }

  if (user.isLocked && user.isLocked()) {
    return res.status(403).json({
      status: 'fail',
      message: req.t('AUTH.ACCOUNT_LOCKED'),
    });
  }

  const validPassword = await user.comparePassword(password);
  if (!validPassword) {
    if (user.incLoginAttempts) user.incLoginAttempts();
    await user.save({ validateBeforeSave: false });
    return res.status(401).json({ status: 'fail', message: req.t('AUTH.INVALID_CREDENTIALS') });
  }

  if (!user.isActive) return res.status(403).json({ status: 'fail', message: req.t('COMMON.ACCOUNT_SUSPENDED') });
  if (!user.isVerified) return res.status(403).json({ status: 'fail', message: req.t('AUTH.VERIFY_EMAIL_FIRST') });

  // Reset brute-force counters
  user.loginAttempts = 0;
  user.lockUntil = undefined;
  await user.save({ validateBeforeSave: false });

  // Flush/overwrite any dead/existing token records for this user ID
  await RefreshToken.deleteMany({ userId: user._id });

  const accessToken = signToken(user._id, user.tokenVersion);
  const refreshToken = signRefreshToken(user._id, user.tokenVersion);

  await persistRefreshToken(user._id, refreshToken, req);
  setRefreshCookie(res, refreshToken);

  user.password = undefined;
  res.status(200).json({
    status: 'success',
    token: accessToken,
    // refreshToken is also returned in the body for mobile/API clients
    // that cannot read httpOnly cookies (e.g. Supertest in tests).
    refreshToken,
    data: {
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    },
  });
});

// ─── Refresh Token ──────────────────────────────────────────
// Intentional: catch returns 401 (not next(err)) — any error here means the
// refresh token is invalid, so we respond uniformly with 401.
exports.refreshToken = async (req, res, next) => {
  try {
    const refreshToken = req.cookies.refreshToken || req.body.refreshToken;
    if (!refreshToken) return res.status(401).json({ status: 'fail', message: req.t('AUTH.REFRESH_TOKEN_REQUIRED') });

    const decoded = verifyRefreshToken(refreshToken);
    const tokenHash = RefreshToken.hashToken(refreshToken);

    const storedToken = await RefreshToken.findOne({ tokenHash, userId: decoded.id, isRevoked: false });
    if (!storedToken || storedToken.expiresAt < new Date()) {
      return res.status(401).json({ status: 'fail', message: req.t('AUTH.INVALID_REFRESH_TOKEN') });
    }

    const user = await User.findById(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ status: 'fail', message: req.t('AUTH.USER_NOT_FOUND_OR_BANNED') });
    }

    // Token rotation — revoke old, issue new
    await RefreshToken.findByIdAndUpdate(storedToken._id, { isRevoked: true });

    const newAccessToken = signToken(user._id, user.tokenVersion);
    const newRefreshToken = signRefreshToken(user._id, user.tokenVersion);

    await persistRefreshToken(user._id, newRefreshToken, req);
    setRefreshCookie(res, newRefreshToken);

    res.status(200).json({ status: 'success', token: newAccessToken, refreshToken: newRefreshToken });
  } catch (_err) {
    // Any JWT / DB error → treat as invalid token
    return res.status(401).json({ status: 'fail', message: req.t('AUTH.INVALID_REFRESH_TOKEN') });
  }
};

// ─── Logout ─────────────────────────────────────────────────
exports.logout = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies.refreshToken || req.body.refreshToken;
  if (refreshToken) {
    const tokenHash = RefreshToken.hashToken(refreshToken);
    await RefreshToken.findOneAndUpdate(
      { tokenHash, userId: req.user._id },
      { isRevoked: true }
    );
  }

  res.clearCookie('refreshToken', { path: '/', httpOnly: true, secure: true, sameSite: 'none' });
  res.status(200).json({ status: 'success', message: req.t('AUTH.LOGOUT_SUCCESS') });
});

// ─── Logout All Devices ──────────────────────────────────────
exports.logoutAll = asyncHandler(async (req, res) => {
  await RefreshToken.updateMany({ userId: req.user._id }, { isRevoked: true });
  res.clearCookie('refreshToken', { path: '/', httpOnly: true, secure: true, sameSite: 'none' });
  res.status(200).json({ status: 'success', message: req.t('AUTH.LOGOUT_ALL_SUCCESS') });
});

// ─── Forgot Password ─────────────────────────────────────────
exports.forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ status: 'fail', message: req.t('AUTH.EMAIL_REQUIRED') });

  const user = await User.findOne({ email });
  // Always return 200 to prevent email enumeration
  if (!user) {
    return res.status(200).json({ status: 'success', message: req.t('AUTH.RESET_EMAIL_SENT') });
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  user.passwordResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
  user.passwordResetExpiry = Date.now() + 15 * 60 * 1000; // 15 minutes
  await user.save({ validateBeforeSave: false });

  try {
    await sendPasswordResetEmail(user.email, resetToken);
    logger.info(`[Password Reset] Email sent to ${user.email}`);
  } catch (emailError) {
    logger.error(`[Password Reset] Failed to send email: ${emailError.message}`);
    // Roll back the token so the user can retry
    user.passwordResetToken = undefined;
    user.passwordResetExpiry = undefined;
    await user.save({ validateBeforeSave: false });
    throw emailError; // propagate — error middleware returns 500
  }

  res.status(200).json({ status: 'success', message: req.t('AUTH.RESET_EMAIL_SENT') });
});

// ─── Reset Password ──────────────────────────────────────────
exports.resetPassword = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  // FIX: schema min is 8, guard must match
  if (!password || password.length < 8) {
    return res.status(400).json({ status: 'fail', message: req.t('AUTH.PASSWORD_MIN_LENGTH') });
  }

  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpiry: { $gt: Date.now() },
  });

  if (!user) return res.status(400).json({ status: 'fail', message: req.t('AUTH.RESET_LINK_INVALID') });

  user.password = password;
  user.passwordResetToken = undefined;
  user.passwordResetExpiry = undefined;
  await user.save();

  // Revoke all old sessions
  await RefreshToken.updateMany({ userId: user._id }, { isRevoked: true });

  const newAccessToken = signToken(user._id, user.tokenVersion);
  const newRefreshToken = signRefreshToken(user._id, user.tokenVersion);

  await RefreshToken.create({
    userId: user._id,
    tokenHash: RefreshToken.hashToken(newRefreshToken),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  setRefreshCookie(res, newRefreshToken);

  res.status(200).json({
    status: 'success',
    message: req.t('AUTH.PASSWORD_RESET_SUCCESS'),
    token: newAccessToken,
  });
});

// NOTE: getMe endpoint is in user.controller.js for better organisation
