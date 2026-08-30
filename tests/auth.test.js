/**
 * Authentication Tests
 * Covers: register, login, /me, logout.
 *
 * NOTE: Registration creates unverified users.
 * Login requires isVerified = true, so tests that need login
 * use the global `createVerifiedUser` helper from setup.js.
 */

const request = require('supertest');
const { app } = require('../src/server');
const User = require('../src/models/user.model');
const mongoose = require('mongoose');
// global.createVerifiedUser is available automatically

describe('Auth Routes', () => {

  // Clean up users after each test to avoid duplicate email issues
  afterEach(async () => {
    await User.deleteMany({});
  });

  // NOTE: Connection lifecycle managed by setup.js (setupFilesAfterEnv).

  // ── Registration ──────────────────────────────────────────────
  describe('POST /api/v1/auth/register', () => {
    it('should register a new user successfully (status 201)', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ name: 'Test User', email: 'test.user@gmail.com', password: 'password123' });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.user).toBeDefined();
      expect(res.body.data.user.email).toBe('test.user@gmail.com');
      expect(res.body.data.user.isVerified).toBe(true);
    });

    it('should always assign "buyer" role (ignores role in payload)', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ name: 'Hacker', email: 'hacker.user@gmail.com', password: 'Test@1234', role: 'admin' });

      expect(res.status).toBe(201);
      expect(res.body.data.user.role).toBe('buyer');
    });

    it('should reject fake and disposable email addresses with 400', async () => {
      const fakeEmails = ['test@test.com', 'test@example.com', 'demo@demo.com', 'user@mailinator.com'];
      for (const email of fakeEmails) {
        const res = await request(app)
          .post('/api/v1/auth/register')
          .send({ name: 'Fake User', email, password: 'password123' });

        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Please use a valid personal or business email address.');
      }
    });

    it('should reject duplicate email with 400', async () => {
      await request(app).post('/api/v1/auth/register')
        .send({ name: 'User1', email: 'dup.user@gmail.com', password: 'Test@1234' });

      const res = await request(app).post('/api/v1/auth/register')
        .send({ name: 'User2', email: 'dup.user@gmail.com', password: 'pass456' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('fail');
    });

    it('should reject missing required fields with 400', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: 'noname.user@gmail.com' });

      expect(res.status).toBe(400);
    });
  });

  // ── Login ─────────────────────────────────────────────────────
  describe('POST /api/v1/auth/login', () => {
    let verifiedUser;

    beforeEach(async () => {
      // Create a verified user before each login test
      verifiedUser = await createVerifiedUser(request, app, {
        name: 'Login User', email: 'login.user@gmail.com', password: 'correctpass',
      });
    });

    it('should login with correct credentials and return tokens', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'login.user@gmail.com', password: 'correctpass' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.token).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.data.user.email).toBe('login.user@gmail.com');
    });

    it('should reject wrong password with 401', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'login.user@gmail.com', password: 'wrongpass' });

      expect(res.status).toBe(401);
    });

    it('should reject non-existent user with 401', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'ghost.user@gmail.com', password: 'Test@1234' });

      expect(res.status).toBe(401);
    });

    it('should reject unverified user with 403', async () => {
      // Manually create an unverified user in DB
      await User.create({ name: 'Unverified', email: 'unverified.user@gmail.com', password: 'Test@1234', isVerified: false });

      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'unverified.user@gmail.com', password: 'Test@1234' });

      expect(res.status).toBe(403);
    });
  });

  // ── Protected: /me ───────────────────────────────────────────
  describe('GET /api/v1/auth/me', () => {
    it('should return current user profile when authenticated', async () => {
      const { token } = await createVerifiedUser(request, app, {
        name: 'Me User', email: 'me.user@gmail.com', password: 'Test@1234',
      });

      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe('me.user@gmail.com');
    });

    it('should reject unauthenticated request with 401', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
    });

    it('should reject invalid/malformed token with 401', async () => {
      const res = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', 'Bearer invalid.token.here');

      expect(res.status).toBe(401);
    });
  });

  // ── Logout ───────────────────────────────────────────────────
  describe('POST /api/v1/auth/logout', () => {
    it('should logout successfully', async () => {
      const { token, refreshToken } = await createVerifiedUser(request, app, {
        name: 'Logout User', email: 'logout.user@gmail.com', password: 'Test@1234',
      });

      const res = await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .send({ refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });
  });

  // ── Admin Export Users Excel ─────────────────────────────────
  describe('GET /api/v1/dashboard/admin/users/export', () => {
    it('should allow admins to export users to Excel (.xlsx)', async () => {
      const { token } = await createVerifiedUser(request, app, {
        name: 'Admin User', email: 'admin.export@gmail.com', password: 'Test@1234', role: 'admin',
      });

      // Create a couple of additional users to export
      await User.create({ name: 'Buyer 1', email: 'buyer1.user@gmail.com', password: 'password123', role: 'buyer', isVerified: true });
      await User.create({ name: 'Owner 1', email: 'owner1.user@gmail.com', password: 'password123', role: 'owner', isVerified: true });

      const res = await request(app)
        .get('/api/v1/dashboard/admin/users/export')
        .set('Authorization', `Bearer ${token}`)
        .buffer(true)
        .parse((res, callback) => {
          res.setEncoding('binary');
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => { callback(null, Buffer.from(data, 'binary')); });
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(res.headers['content-disposition']).toContain('attachment; filename=users-export-');

      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body);
      const worksheet = workbook.getWorksheet('Users');
      expect(worksheet).toBeDefined();

      const headerRow = worksheet.getRow(1);
      expect(headerRow.getCell(1).value).toBe('User ID');
      expect(headerRow.getCell(2).value).toBe('Name');
      expect(headerRow.getCell(3).value).toBe('Email');

      const names = [];
      worksheet.eachRow((row, rowNum) => {
        if (rowNum > 1) {
          names.push(row.getCell(2).value);
        }
      });
      expect(names).toContain('Buyer 1');
      expect(names).toContain('Owner 1');
    });

    it('should reject non-admin users with 403', async () => {
      const { token } = await createVerifiedUser(request, app, {
        name: 'Normal User', email: 'buyer.export@gmail.com', password: 'Test@1234', role: 'buyer',
      });

      const res = await request(app)
        .get('/api/v1/dashboard/admin/users/export')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });

});