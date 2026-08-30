const { validateEmail, addBlockedDomains } = require('../src/utils/emailValidator');

describe('Email Validator Utility', () => {
  describe('Blocked Test & Fake Emails', () => {
    const fakeEmails = [
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
    ];

    fakeEmails.forEach((email) => {
      it(`should reject fake/test email: ${email}`, () => {
        const result = validateEmail(email);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Please use a valid personal or business email address.');
      });
    });
  });

  describe('Blocked Disposable Domains', () => {
    const disposableEmails = [
      'randomuser@mailinator.com',
      'temp@10minutemail.com',
      'testuser@guerrillamail.com',
      'user123@temp-mail.org',
      'myname@yopmail.com',
      'test@getnada.com',
      'testing@emailondeck.com',
      'user@throwawaymail.com',
    ];

    disposableEmails.forEach((email) => {
      it(`should reject disposable domain email: ${email}`, () => {
        const result = validateEmail(email);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Please use a valid personal or business email address.');
      });
    });
  });

  describe('Allowed Real / Trusted Emails', () => {
    const realEmails = [
      'test@gmail.com',
      'demo@gmail.com',
      'user@gmail.com',
      'admin@gmail.com',
      'test@outlook.com',
      'user@yahoo.com',
      'demo@icloud.com',
      'john.doe@company.com',
      'contact@realestatebrand.ae',
    ];

    realEmails.forEach((email) => {
      it(`should allow legitimate real email: ${email}`, () => {
        const result = validateEmail(email);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      });
    });
  });

  describe('Malformed Emails', () => {
    const invalidFormatEmails = [
      '',
      'notanemail',
      'test@',
      '@domain.com',
      'test@.com',
      'test@domain',
      null,
      undefined,
    ];

    invalidFormatEmails.forEach((email) => {
      it(`should reject malformed email: ${email}`, () => {
        const result = validateEmail(email);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('Please use a valid personal or business email address.');
      });
    });
  });

  describe('Extensibility (addBlockedDomains)', () => {
    it('should dynamically block new custom domains', () => {
      expect(validateEmail('user@newdisposable.com').valid).toBe(true);

      addBlockedDomains(['newdisposable.com']);

      expect(validateEmail('user@newdisposable.com').valid).toBe(false);
    });
  });
});
