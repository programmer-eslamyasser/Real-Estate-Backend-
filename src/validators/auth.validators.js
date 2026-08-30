const { body } = require('express-validator');
const i18next = require('../config/i18n').i18next;
const { validateEmail } = require('../utils/emailValidator');

// Helper: returns the translation key directly
const t = (key) => key;

exports.registerSchema = [
  body('name').notEmpty().withMessage(t('VALIDATION.NAME_REQUIRED'))
    .isLength({ min: 3, max: 50 }).withMessage(t('VALIDATION.NAME_LENGTH')),
  body('email').notEmpty().withMessage(t('VALIDATION.EMAIL_REQUIRED'))
    .isEmail().withMessage(t('VALIDATION.EMAIL_INVALID'))
    .custom((val) => {
      const result = validateEmail(val);
      if (!result.valid) {
        throw new Error(result.error || 'Please use a valid personal or business email address.');
      }
      return true;
    }),
  body('password').notEmpty().withMessage(t('VALIDATION.PASSWORD_REQUIRED'))
    .isLength({ min: 8 }).withMessage(t('VALIDATION.PASSWORD_MIN')),
  body('phone').optional()
    .matches(/^[0-9+\-\s]{7,15}$/).withMessage(t('VALIDATION.PHONE_INVALID')),
  // ✅ SECURITY FIX: Role NOT accepted during registration
  // Server controls role assignment - prevents privilege escalation
  // Users cannot inject 'agent' or other roles during signup
];

exports.loginSchema = [
  body('email').notEmpty().withMessage(t('VALIDATION.EMAIL_REQUIRED'))
    .isEmail().withMessage(t('VALIDATION.EMAIL_INVALID')),
  body('password').notEmpty().withMessage(t('VALIDATION.PASSWORD_REQUIRED')),
];

exports.updateUserRoleSchema = [
  body('userId').notEmpty().isMongoId().withMessage(t('VALIDATION.USER_ID_INVALID')),
  body('newRole').notEmpty().isIn(['buyer', 'owner', 'agent']).withMessage(t('VALIDATION.ROLE_INVALID')),
];

exports.changePasswordSchema = [
  body('currentPassword').notEmpty().withMessage(t('VALIDATION.CURRENT_PASSWORD_REQUIRED')),
  body('newPassword').notEmpty().withMessage(t('VALIDATION.NEW_PASSWORD_REQUIRED'))
    .isLength({ min: 8 }).withMessage(t('VALIDATION.NEW_PASSWORD_MIN'))
    .custom((val, { req }) => {
      if (val === req.body.currentPassword) throw new Error(req.t('VALIDATION.NEW_PASSWORD_SAME'));
      return true;
    }),
];
