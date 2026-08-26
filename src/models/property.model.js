const mongoose = require('mongoose');

const BilingualTitleSchema = new mongoose.Schema({
  en: {
    type: String,
    required: [true, 'VALIDATION.TITLE_REQUIRED'],
    trim: true,
    minlength: [10, 'VALIDATION.TITLE_LENGTH'],
    maxlength: [100, 'VALIDATION.TITLE_MAX'],
  },
  ar: {
    type: String,
    required: [true, 'VALIDATION.TITLE_REQUIRED'],
    trim: true,
    minlength: [10, 'VALIDATION.TITLE_LENGTH'],
    maxlength: [100, 'VALIDATION.TITLE_MAX'],
  }
}, { _id: false });

const BilingualDescriptionSchema = new mongoose.Schema({
  en: {
    type: String,
    required: [true, 'VALIDATION.DESCRIPTION_REQUIRED'],
    minlength: [20, 'VALIDATION.DESCRIPTION_MIN'],
  },
  ar: {
    type: String,
    required: [true, 'VALIDATION.DESCRIPTION_REQUIRED'],
    minlength: [20, 'VALIDATION.DESCRIPTION_MIN'],
  }
}, { _id: false });

const BilingualCitySchema = new mongoose.Schema({
  en: { type: String, required: [true, 'VALIDATION.CITY_REQUIRED'] },
  ar: { type: String, required: [true, 'VALIDATION.CITY_REQUIRED'] }
}, { _id: false });

const BilingualDistrictSchema = new mongoose.Schema({
  en: { type: String, required: [true, 'VALIDATION.DISTRICT_REQUIRED'] },
  ar: { type: String, required: [true, 'VALIDATION.DISTRICT_REQUIRED'] }
}, { _id: false });

const bilingualSetter = function(val) {
  if (typeof val === 'string') {
    return { en: val, ar: val };
  }
  return val;
};

const propertySchema = new mongoose.Schema(
  {
    title: {
      type: BilingualTitleSchema,
      required: [true, 'VALIDATION.TITLE_REQUIRED'],
      set: bilingualSetter
    },
    description: {
      type: BilingualDescriptionSchema,
      required: [true, 'VALIDATION.DESCRIPTION_REQUIRED'],
      set: bilingualSetter
    },
    price: {
      type: Number,
      required: [true, 'VALIDATION.PRICE_REQUIRED'],
      min: [0, 'VALIDATION.PRICE_MIN'],
    },
    // ── FIX #5: currency — stored per property ──────────────────────────────
    currency: {
      type: String,
      enum: { values: ['USD', 'GBP', 'EUR', 'AED', 'SAR', 'EGP'], message: 'VALIDATION.CURRENCY_INVALID' },
      default: 'USD',
    },
    type: {
      type: String,
      required: [true, 'VALIDATION.TYPE_REQUIRED'],
      enum: {
        values: ['apartment', 'villa', 'house', 'studio', 'office', 'shop', 'land', 'commercial'],
        message: 'VALIDATION.TYPE_INVALID',
      },
    },
    listingType: {
      type: String,
      enum: { values: ['sale', 'rent'], message: 'VALIDATION.LISTING_TYPE_INVALID' },
      default: 'sale',
    },
    status: {
      type: String,
      enum: ['available', 'reserved', 'sold'],
      default: 'available',
    },
    location: {
      city: {
        type: BilingualCitySchema,
        required: [true, 'VALIDATION.CITY_REQUIRED'],
        set: bilingualSetter
      },
      district: {
        type: BilingualDistrictSchema,
        required: [true, 'VALIDATION.DISTRICT_REQUIRED'],
        set: bilingualSetter
      },
      street:   { type: String },
    },
    slug: {
      en: { type: String, unique: true, sparse: true, index: true },
      ar: { type: String, unique: true, sparse: true, index: true }
    },
    area:      { type: Number, min: [0, 'VALIDATION.AREA_MIN'] },
    rooms:     { type: Number, default: 0, min: 0 },
    bedrooms:  { type: Number, default: 0, min: 0 },
    bathrooms: { type: Number, default: 0, min: 0 },
    images:    { type: [String], default: [] },
    // ── FIX #5: features — list of amenities ────────────────────────────────
    features: {
      type: [String],
      default: [],
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'VALIDATION.PROPERTY_OWNER_REQUIRED'],
    },
    avgRating: {
      type: Number,
      default: 0,
      min: [0, 'VALIDATION.RATING_MIN'],
      max: [5, 'VALIDATION.RATING_MAX'],
      set: (val) => Math.round(val * 10) / 10,
    },
    reviewCount: { type: Number, default: 0 },
    isApproved:  { type: Boolean, default: false }, // Property needs admin approval before publishing
    promotion: {
      isFeatured: { type: Boolean, default: false },
      featuredUntil: { type: Date },
      isBoosted: { type: Boolean, default: false },
      boostedUntil: { type: Date },
      hasPremiumBadge: { type: Boolean, default: false },
    },
    promotionScore: { type: Number, default: 0, index: true }, // For ranking algorithm
  },
  {
    timestamps: true,
    toJSON:   { virtuals: true },
    toObject: { virtuals: true },
  }
);


// Indexes for query performance
propertySchema.index({ price: 1 });
propertySchema.index({ type: 1 });
propertySchema.index({ listingType: 1 });
propertySchema.index({ 'location.city': 1 });
propertySchema.index({ owner: 1 });
propertySchema.index({ status: 1 });
propertySchema.index({ isApproved: 1, status: 1, promotionScore: -1 });
propertySchema.index({ isApproved: 1, promotionScore: -1, createdAt: -1 });
propertySchema.index({ promotionScore: -1, createdAt: -1 });
propertySchema.index({ owner: 1, createdAt: -1 });

// Compound indexes for optimized filtering
propertySchema.index({ 'location.city': 1, 'location.district': 1 });
propertySchema.index({ price: 1, type: 1, listingType: 1 });

// Text Index for full-text search engine
propertySchema.index(
  {
    'title.en': 'text',
    'title.ar': 'text',
    'description.en': 'text',
    'description.ar': 'text',
    'location.city.en': 'text',
    'location.city.ar': 'text',
    'location.district.en': 'text',
    'location.district.ar': 'text'
  },
  {
    weights: {
      'title.en': 10,
      'title.ar': 10,
      'location.city.en': 5,
      'location.city.ar': 5,
      'description.en': 1,
      'description.ar': 1
    }
  }
);

// Virtual populate for reviews
propertySchema.virtual('reviews', {
  ref:          'Review',
  foreignField: 'propertyId',
  localField:   '_id',
});

// FIX #5 — badge virtual: derived from listingType so frontend gets it automatically
propertySchema.virtual('badge').get(function () {
  return this.listingType === 'rent' ? 'For Rent' : 'For Sale';
});

// approvalStatus virtual: derived from isApproved
propertySchema.virtual('approvalStatus').get(function () {
  return this.isApproved ? 'approved' : 'pending';
});

// Helper: dynamic slugification for both LTR and RTL strings
function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\s\-\u0600-\u06FF]+/g, '')
    .replace(/[\s\_]+/g, '-')
    .replace(/\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}



// Pre-save Mongoose hook to ensure bilingual unique SEO slugs
propertySchema.pre('save', async function () {
  if (this.title?.en && (this.isModified('title.en') || !this.slug?.en)) {
    let baseSlug = slugify(this.title.en);
    let uniqueSlug = baseSlug;
    let counter = 1;
    while (await mongoose.models.Property.findOne({ 'slug.en': uniqueSlug, _id: { $ne: this._id } })) {
      uniqueSlug = `${baseSlug}-${counter++}`;
    }
    this.slug = this.slug || {};
    this.slug.en = uniqueSlug;
  }

  if (this.title?.ar && (this.isModified('title.ar') || !this.slug?.ar)) {
    let baseSlug = slugify(this.title.ar);
    let uniqueSlug = baseSlug;
    let counter = 1;
    while (await mongoose.models.Property.findOne({ 'slug.ar': uniqueSlug, _id: { $ne: this._id } })) {
      uniqueSlug = `${baseSlug}-${counter++}`;
    }
    this.slug = this.slug || {};
    this.slug.ar = uniqueSlug;
  }
});

module.exports = mongoose.model('Property', propertySchema);

