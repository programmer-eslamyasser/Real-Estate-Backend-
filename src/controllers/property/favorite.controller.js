const Favorite = require('../../models/favorite.model');
const Property = require('../../models/property.model');
const asyncHandler = require('../../utils/asyncHandler');
const { getPaginationParams } = require('../../utils/paginate');

exports.addFavorite = asyncHandler(async (req, res) => {
  try {
    const { propertyId } = req.body;
    const property = await Property.findById(propertyId);
    if (!property) return res.status(404).json({ status: 'fail', message: req.t('PROPERTY.NOT_FOUND') });

    const favorite = await Favorite.create({ user_id: req.user._id, property_id: propertyId });
    await favorite.populate('property_id', 'title price location images avgRating');

    res.status(201).json({ status: 'success', message: req.t('FAVORITE.ADDED'), data: { favorite } });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ status: 'fail', message: req.t('FAVORITE.ALREADY_EXISTS') });
    }
    throw err;
  }
});

exports.getFavorites = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPaginationParams(req.query);

  const [total, favorites] = await Promise.all([
    Favorite.countDocuments({ user_id: req.user._id }),
    Favorite.find({ user_id: req.user._id })
      .populate('property_id')
      .skip(skip)
      .limit(limit)
      .sort({ created_at: -1 })
      .lean(),
  ]);

  res.status(200).json({
    status: 'success',
    count: favorites.length,
    total,
    page,
    pages: Math.ceil(total / limit),
    data: { favorites },
  });
});

exports.removeFavorite = asyncHandler(async (req, res) => {
  const deleted = await Favorite.findOneAndDelete({
    user_id:     req.user._id,
    property_id: req.params.propertyId,
  });
  if (!deleted) return res.status(404).json({ status: 'fail', message: req.t('FAVORITE.NOT_FOUND') });
  res.status(200).json({ status: 'success', message: req.t('FAVORITE.REMOVED') });
});
