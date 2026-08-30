/**
 * Email Validation Utility
 * Validates email format, prevents test/fake emails, and blocks disposable/temporary email domains.
 */

// Explicit exact fake/test email addresses to block
const BLOCKED_EXACT_EMAILS = new Set([
  'test@test.com',
  'test@example.com',
  'example@example.com',
  'demo@demo.com',
  'admin@admin.com',
  'user@user.com',
  'fake@fake.com',
  'temp@temp.com',
  'sample@sample.com',
  'testing@testing.com',
  'test123@test.com',
  'demo123@demo.com',
]);

// Known disposable / test email domains
const BLOCKED_DOMAINS = new Set([
  // Test/Fake domains
  'test.com',
  'example.com',
  'example.net',
  'example.org',
  'demo.com',
  'admin.com',
  'user.com',
  'fake.com',
  'temp.com',
  'sample.com',
  'testing.com',
  // Disposable / Temporary email services
  'mailinator.com',
  '10minutemail.com',
  'guerrillamail.com',
  'temp-mail.org',
  'yopmail.com',
  'getnada.com',
  'emailondeck.com',
  'throwawaymail.com',
  'dispostable.com',
  'trashmail.com',
  'sharklasers.com',
  'maildrop.cc',
  'crazymailing.com',
  'inboxalias.com',
  'mytemp.email',
  'tempmail.net',
  'tempmail.com',
  'fakeinbox.com',
  'generator.email',
  'getairmail.com',
  'guerrillamail.block',
  'guerrillamail.info',
  'guerrillamail.biz',
  'guerrillamail.de',
  'guerrillamail.net',
  'guerrillamail.org',
  'grr.la',
  'pokemail.net',
  'spam4.me',
  '0-mail.com',
  '10minute-email.com'
]);

// Allowed trusted major email providers (always allowed regardless of username prefix)
const TRUSTED_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'zoho.com'
]);

const DEFAULT_ERROR_MESSAGE = 'Please use a valid personal or business email address.';

/**
 * Validates an email address against format, blacklisted emails, and disposable domains.
 * @param {string} email
 * @returns {{ valid: boolean, error?: string }}
 */
function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: DEFAULT_ERROR_MESSAGE };
  }

  const cleanEmail = email.trim().toLowerCase();

  // Basic regex format check
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    return { valid: false, error: DEFAULT_ERROR_MESSAGE };
  }

  // Check exact blocked email list
  if (BLOCKED_EXACT_EMAILS.has(cleanEmail)) {
    return { valid: false, error: DEFAULT_ERROR_MESSAGE };
  }

  const parts = cleanEmail.split('@');
  if (parts.length !== 2) {
    return { valid: false, error: DEFAULT_ERROR_MESSAGE };
  }

  const [, domain] = parts;

  // Check blocked domains list
  if (BLOCKED_DOMAINS.has(domain)) {
    return { valid: false, error: DEFAULT_ERROR_MESSAGE };
  }

  // If domain is a trusted real email provider, explicitly allow it
  if (TRUSTED_DOMAINS.has(domain)) {
    return { valid: true };
  }

  return { valid: true };
}

/**
 * Allows dynamic extension of blocked domains list.
 * @param {string[]} domains
 */
function addBlockedDomains(domains) {
  if (Array.isArray(domains)) {
    domains.forEach((d) => {
      if (typeof d === 'string') BLOCKED_DOMAINS.add(d.trim().toLowerCase());
    });
  }
}

module.exports = {
  validateEmail,
  addBlockedDomains,
  BLOCKED_EXACT_EMAILS,
  BLOCKED_DOMAINS,
  TRUSTED_DOMAINS,
  DEFAULT_ERROR_MESSAGE
};
