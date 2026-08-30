const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: 3,
      maxlength: 50,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Invalid email'],
    },
    password: {
      type: String,
      // Required only for local auth — Google users have no password
      required: function () { return this.authProvider === 'local'; },
      minlength: 8,
      select: false,
    },

    // ── OAuth ──────────────────────────────────────────────
    googleId: {
      type: String,
      unique: true,
      sparse: true,   // allows multiple null values (only one index per googleId)
      select: false,
    },
    authProvider: {
      type: String,
      enum: { values: ['local', 'google'], message: 'Invalid auth provider' },
      default: 'local',
    },

    phone: { type: String, default: null },
    role: {
      type: String,
      enum: { values: ['buyer', 'owner', 'agent', 'admin'], message: 'Invalid role' },
      default: 'buyer',
    },
    photo: { type: String, default: null },
    bio: { type: String, default: '' },

    // ── Granular Permission System (Phase 3.3) ──────────────────
    // Empty array = legacy Super Admin with full access (backwards compatible).
    // Non-empty array = restricted admin with only listed permissions.
    permissions: {
      type: [String],
      default: [],
      enum: {
        values: [
          'approve_property', 'reject_property',
          'approve_booking', 'reject_booking',
          'ban_user', 'change_role', 'update_permissions',
          'approve_kyc', 'reject_kyc',
          'delete_review', 'view_audit_logs',
          'export_data', 'bulk_actions',
        ],
        message: 'Invalid permission: {VALUE}',
      },
    },

    isVerified: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    isBanned: { type: Boolean, default: false },

    //  Subscription Management
    activeSubscription: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      default: null,
    },
    subscriptionStatus: {
      type: String,
      enum: ['none', 'active', 'expired', 'cancelled'],
      default: 'none',
      index: true,
    },

    //  Security
    passwordChangedAt: { type: Date, select: false },
    tokenVersion: { type: Number, default: 0 }, // logout all

    //  OTP (Email Verification / Reset)
    otpHash: { type: String, select: false },
    otpExpires: { type: Date, select: false },
    otpAttempts: { type: Number, default: 0, select: false },

    //  Password Reset
    passwordResetToken: { type: String, select: false },
    passwordResetExpiry: { type: Date, select: false },

    //  Login Protection
    loginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date },

    //  KYC / Identity Verification
    kycStatus: {
      type: String,
      enum: { values: ['not_submitted', 'pending', 'approved', 'rejected'], message: 'Invalid KYC status' },
      default: 'not_submitted',
      index: true,
    },
    kycNationality: {
      type: String,
      required: function () { return this.kycStatus === 'pending' || this.kycStatus === 'approved'; }
    },
    kycPhoneNumber: {
      type: String,
      required: function () { return this.kycStatus === 'pending' || this.kycStatus === 'approved'; }
    },
    kycLivePhoto: {
      type: String,
      required: function () { return this.kycStatus === 'pending' || this.kycStatus === 'approved'; }
    },
    kycDocuments: [
      {
        type: {
          type: String,
          enum: ['national_id', 'passport', 'drivers_license'],
          required: true,
        },
        frontImage: {
          type: String,  // Cloudinary signed URL
          required: true,
        },
        backImage: String,  // Optional for some document types
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    kycSubmittedAt: { type: Date, select: false },
    kycVerifiedAt: { type: Date, select: false },
    kycApprovedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      select: false,
    },
    kycApprovedAt: { type: Date, select: false },
    kycRejectionReason: { type: String, select: false },
    kycAttempts: { type: Number, default: 0, select: false },
    kycVersion: { type: Number, default: 1 }, // Enterprise versioning for Admin reviews

    // Property Ownership Verification (for Owners/Agents)
    ownershipDocuments: [
      {
        imageUrl: { type: String },           // legacy field (images)
        fileUrl: { type: String },            // new: Cloudinary URL (images OR PDFs)
        fileName: { type: String },           // original file name
        fileType: { type: String, enum: ['image', 'pdf', 'doc'], default: 'image' },
        isTemporary: { type: Boolean, default: true }, // true until KYC is submitted
        uploadedAt: { type: Date, default: Date.now }
      }
    ],

    //  Bank Accounts (for receiving/paying)
    bankAccounts: [
      {
        ibanEncrypted: {
          type: String,  // AES-256 encrypted IBAN
          select: false,
        },
        ibanLast4: String,  // Last 4 digits for display (non-sensitive)
        accountHolderName: String,
        bankName: String,
        isDefault: { type: Boolean, default: false },
        encryptionTag: String,  // Unique salt per account
        createdAt: { type: Date, default: Date.now },
      },
    ],
    balance_USD: {
      type: Number,
      default: 0,
      min: [0, 'Balance cannot be negative'],
    },
    wallet: {
      type: Number,
      default: 0,
      min: [0, 'Wallet balance cannot be negative'],
    },
  },
  { timestamps: true }
);

// Indexes
// Note: email index is created automatically by unique: true
userSchema.index({ isActive: 1 });
userSchema.index({ kycSubmittedAt: 1 });


//  Hash Password

userSchema.pre('save', async function () {
  // Skip hashing if password not set (Google users) or not modified
  if (!this.password || !this.isModified('password')) return;

  this.password = await bcrypt.hash(this.password, 12);

  if (!this.isNew) {
    this.passwordChangedAt = new Date(Date.now() - 1000);
    this.tokenVersion += 1; // invalidate tokens
  }
});


//  Compare Password

userSchema.methods.comparePassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};


//  OTP Generator

userSchema.methods.createOTP = function () {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  const hash = crypto.createHash('sha256').update(otp).digest('hex');

  this.otpHash = hash;
  this.otpExpires = Date.now() + 10 * 60 * 1000; // 10 min
  this.otpAttempts = 0;

  return otp;
};


//  Verify OTP

userSchema.methods.verifyOTP = function (enteredOtp) {
  const hash = crypto.createHash('sha256').update(enteredOtp).digest('hex');

  if (this.otpExpires < Date.now()) return false;

  if (this.otpAttempts >= 5) return false;

  if (hash !== this.otpHash) {
    this.otpAttempts += 1;
    return false;
  }

  // success
  this.otpHash = undefined;
  this.otpExpires = undefined;
  this.otpAttempts = 0;

  return true;
};


//  Account Lock Check

userSchema.methods.isLocked = function () {
  return this.lockUntil && this.lockUntil > Date.now();
};


//  Handle Failed Login

userSchema.methods.incLoginAttempts = function () {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    this.loginAttempts = 1;
    this.lockUntil = undefined;
  } else {
    this.loginAttempts += 1;

    if (this.loginAttempts >= 5) {
      this.lockUntil = Date.now() + 15 * 60 * 1000; // 15 min
    }
  }
};

// ── Performance Indexes (Admin User Management) ───────────────
userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ isBanned: 1, createdAt: -1 });
userSchema.index({ name: 'text', email: 'text' }); // full-text search

module.exports = mongoose.model('User', userSchema);
