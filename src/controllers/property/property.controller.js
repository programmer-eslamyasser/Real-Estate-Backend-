const cloudinary = require('../../config/cloudinary');
const Property = require('../../models/property.model');
const Review = require('../../models/review.model');
const Favorite = require('../../models/favorite.model');
const Booking = require('../../models/booking.model');
const Inquiry = require('../../models/inquiry.model');
const ViewingRequest = require('../../models/viewingRequest.model');
const APIFeatures = require('../../utils/apiFeatures');
const asyncHandler = require('../../utils/asyncHandler');
const AppError = require('../../utils/AppError');
const { clearCache } = require('../../middlewares/cache.middleware');
const { checkSavedSearches } = require('../../services/savedSearch.service');
const { getPaginationParams } = require('../../utils/paginate');

// ─── Helper: derive Cloudinary public_id from URL ─────────────────────────────
const publicIdFromUrl = (url) => {
  const parts = url.split('/');
  const file = parts[parts.length - 1].split('.')[0]; // filename without extension
  const folder = parts[parts.length - 2];              // folder segment
  return `${folder}/${file}`;
};

// ─── Create Property ──────────────────────────────────────────────────────────
exports.createProperty = asyncHandler(async (req, res) => {
  const images = req.body.images || [];
  const property = await Property.create({ ...req.body, images, owner: req.user._id });

  // Increment subscription usage if applicable
  if (req.subscription) {
    req.subscription.listingsUsedThisMonth += 1;
    await req.subscription.save();
  }

  clearCache('/api/v1/properties');
  clearCache('/api/v1/search');

  // Fire-and-forget: notify users with matching saved searches
  checkSavedSearches(req.io, property).catch(() => { });

  res.status(201).json({ status: 'success', data: { property } });
});

// ─── Get All Properties ───────────────────────────────────────────────────────
exports.getAllProperties = asyncHandler(async (req, res) => {
  // ── Remap frontend query params → correct Mongoose field paths ─────────────
  const rawQuery = { ...req.query };

  // city/location.city → location.city.en or location.city.ar (nested fields in schema)
  const cityVal = rawQuery.city || rawQuery['location.city'];
  if (cityVal) {
    const escapedCity = String(cityVal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cityRegex = new RegExp(escapedCity, 'i');
    if (!rawQuery.$or) rawQuery.$or = [];
    rawQuery.$or.push(
      { 'location.city.en': cityRegex },
      { 'location.city.ar': cityRegex }
    );
    delete rawQuery.city;
    delete rawQuery['location.city'];
  }

  // district/location.district → location.district.en or location.district.ar
  const districtVal = rawQuery.district || rawQuery['location.district'];
  if (districtVal) {
    const escapedDistrict = String(districtVal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const districtRegex = new RegExp(escapedDistrict, 'i');
    if (!rawQuery.$or) rawQuery.$or = [];
    rawQuery.$or.push(
      { 'location.district.en': districtRegex },
      { 'location.district.ar': districtRegex }
    );
    delete rawQuery.district;
    delete rawQuery['location.district'];
  }

  // title → title.en or title.ar
  const titleVal = rawQuery.title;
  if (titleVal) {
    const escapedTitle = String(titleVal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const titleRegex = new RegExp(escapedTitle, 'i');
    if (!rawQuery.$or) rawQuery.$or = [];
    rawQuery.$or.push(
      { 'title.en': titleRegex },
      { 'title.ar': titleRegex }
    );
    delete rawQuery.title;
  }

  // minPrice / maxPrice → price range operators
  if (rawQuery.minPrice || rawQuery.maxPrice) {
    rawQuery.price = {};
    if (rawQuery.minPrice) { rawQuery.price.gte = Number(rawQuery.minPrice); delete rawQuery.minPrice; }
    if (rawQuery.maxPrice) { rawQuery.price.lte = Number(rawQuery.maxPrice); delete rawQuery.maxPrice; }
  }

  // ── Ranking System: Sort by promotionScore (Featured > Boosted > Normal) ─────────
  // Default sort: promotionScore DESC, createdAt DESC
  const sort = req.query.sort || '-promotionScore,-createdAt';

  const features = new APIFeatures(Property.find({ isApproved: true }), rawQuery)
    .filter()
    .search()
    .sort(sort)
    .limitFields()
    .paginate();

  // If using cursor, we don't strictly need total pages, but we keep it for backward compatibility
  const [properties, total] = await Promise.all([
    features.query.populate('owner', 'name email phone photo').lean(),
    Property.countDocuments({ ...features.filterQuery, isApproved: true }),
  ]);

  // Inject isFavorited using O(1) lookup to prevent N+1 queries
  if (req.user) {
    const favorites = await Favorite.find({ user_id: req.user._id }).select('property_id').lean();
    const favSet = new Set(favorites.map(f => f.property_id.toString()));

    properties.forEach(p => {
      p.isFavorited = favSet.has(p._id.toString());
    });
  }

  // Generate next cursor if properties exist
  let nextCursor = null;
  if (properties.length > 0) {
    const lastDoc = properties[properties.length - 1];
    nextCursor = `${new Date(lastDoc.createdAt).toISOString()}_${lastDoc._id}`;
  }

  if (!req.user) {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  } else {
    res.setHeader('Cache-Control', 'private, no-cache');
  }

  res.status(200).json({
    status: 'success',
    results: properties.length,
    total,
    page: req.query.page * 1 || 1,
    pages: Math.ceil(total / (req.query.limit * 1 || 10)),
    nextCursor, // Return cursor for frontend
    data: { properties },
  });
});

// ─── Get Single Property ──────────────────────────────────────────────────────
exports.getProperty = asyncHandler(async (req, res, next) => {
  const property = await Property.findById(req.params.id)
    .populate('owner', 'name email phone photo bio')
    .populate({
      path: 'reviews',
      options: { limit: 5, sort: { createdAt: -1 } },
      populate: { path: 'userId', select: 'name photo' },
    })
    .lean();

  if (!property) return next(new AppError(req.t('PROPERTY.NOT_FOUND'), 404));

  // Check if the authenticated user has favourited this property
  let isFavorited = false;
  if (req.user) {
    const fav = await Favorite.findOne({
      user_id: req.user._id,
      property_id: property._id,
    });
    isFavorited = !!fav;
    res.setHeader('Cache-Control', 'private, no-cache');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
  }

  res.status(200).json({ status: 'success', data: { property, isFavorited } });
});

// ─── Update Property ──────────────────────────────────────────────────────────
exports.updateProperty = asyncHandler(async (req, res, next) => {
  const property = req.property; // already fetched and verified by isOwner middleware
  const updates = { ...req.body };

  // Append images rather than replace when ?append=true
  if (req.body.images?.length > 0 && req.query.append === 'true') {
    await Property.findByIdAndUpdate(req.params.id, {
      $push: { images: { $each: req.body.images } },
    });
    delete updates.images;
  }

  // Update properties on the existing document and save (runs validation)
  Object.assign(property, updates);
  await property.save();

  clearCache('/api/v1/properties');
  clearCache('/api/v1/search');
  res.status(200).json({ status: 'success', data: { property } });
});

// ─── Delete Property ──────────────────────────────────────────────────────────
exports.deleteProperty = asyncHandler(async (req, res, next) => {
  const property = req.property; // already fetched and verified by isOwner middleware

  // Remove images from Cloudinary (best-effort — don't fail deletion if CDN call fails)
  await Promise.allSettled(
    property.images.map(url => cloudinary.uploader.destroy(publicIdFromUrl(url)))
  );

  // Cascade delete all related documents in parallel
  await Promise.all([
    Review.deleteMany({ propertyId: property._id }),
    Favorite.deleteMany({ property_id: property._id }),
    Booking.deleteMany({ property_id: property._id }),
    Inquiry.deleteMany({ property: property._id }),
    ViewingRequest.deleteMany({ property: property._id }),
  ]);

  await property.deleteOne();
  clearCache('/api/v1/properties');
  clearCache('/api/v1/search');
  res.status(204).json({ status: 'success', data: null });
});

// ─── Delete Single Image ──────────────────────────────────────────────────────
exports.deletePropertyImage = asyncHandler(async (req, res, next) => {
  const { imageUrl } = req.body;
  const property = req.property; // injected by isOwner middleware

  if (!imageUrl) return next(new AppError(req.t('PROPERTY.IMAGE_REQUIRED'), 400));
  if (!property.images.includes(imageUrl)) return next(new AppError(req.t('PROPERTY.IMAGE_NOT_FOUND'), 404));
  if (property.images.length === 1) return next(new AppError(req.t('PROPERTY.CANNOT_DELETE_ONLY_IMAGE'), 400));

  // Best-effort CDN removal
  await cloudinary.uploader.destroy(publicIdFromUrl(imageUrl)).catch(() => { });

  property.images = property.images.filter(img => img !== imageUrl);
  await property.save();

  clearCache('/api/v1/properties');
  res.status(200).json({ status: 'success', data: { images: property.images } });
});

// ─── Get My Properties ────────────────────────────────────────────────────────
exports.getMyProperties = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filter = { owner: req.user._id };
  if (status) filter.status = status;

  const { page, limit, skip } = getPaginationParams(req.query);

  const [total, properties] = await Promise.all([
    Property.countDocuments(filter),
    Property.find(filter)
      .sort('-createdAt')
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  res.status(200).json({
    status: 'success',
    total,
    page,
    pages: Math.ceil(total / limit),
    results: properties.length,
    data: { properties },
  });
});

// ─── Toggle Property Status ───────────────────────────────────────────────────
exports.togglePropertyStatus = asyncHandler(async (req, res, next) => {
  const { status } = req.body;
  const valid = ['available', 'reserved', 'sold'];
  if (!valid.includes(status)) return next(new AppError(req.t('PROPERTY.INVALID_STATUS'), 400));

  const property = req.property; // injected by isOwner middleware
  property.status = status;
  await property.save();

  clearCache('/api/v1/properties');
  res.status(200).json({ status: 'success', data: { property } });
});
