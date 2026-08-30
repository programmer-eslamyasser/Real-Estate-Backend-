const { validationResult } = require('express-validator');

const validate = (schema, source = 'body') => {
  if (Array.isArray(schema)) {
    return [
      ...schema,
      (req, res, next) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          const errList = errors.array().map((e) => (req.t ? req.t(e.msg) : e.msg));
          const firstMsg = errList[0] || (req.t ? req.t('COMMON.VALIDATION_DATA_ERROR') : 'Validation data error');
          return res.status(400).json({
            status:  'fail',
            message: firstMsg,
            errors:  errList,
          });
        }
        next();
      },
    ];
  }
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], { abortEarly: false, stripUnknown: true });
    if (error) {
      const errList = error.details.map((e) => e.message.replace(/"/g, ''));
      const firstMsg = errList[0] || (req.t ? req.t('COMMON.VALIDATION_DATA_ERROR') : 'Validation data error');
      return res.status(400).json({
        status:  'fail',
        message: firstMsg,
        errors:  errList,
      });
    }
    req[source] = value;
    next();
  };
};

module.exports = validate;
