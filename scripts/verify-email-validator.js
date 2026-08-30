const { validateEmail } = require('../src/utils/emailValidator');

console.log('=== RUNNING EMAIL VALIDATION TEST CASES ===');

const testCases = [
  { email: 'test@test.com', expected: false, label: 'test@test.com → Rejected' },
  { email: 'test@example.com', expected: false, label: 'test@example.com → Rejected' },
  { email: 'example@example.com', expected: false, label: 'example@example.com → Rejected' },
  { email: 'demo@demo.com', expected: false, label: 'demo@demo.com → Rejected' },
  { email: 'user@mailinator.com', expected: false, label: 'mailinator.com → Rejected' },
  { email: 'user@10minutemail.com', expected: false, label: '10minutemail.com → Rejected' },
  { email: 'test@gmail.com', expected: true, label: 'Real Gmail (test@gmail.com) → Allowed' },
  { email: 'test@outlook.com', expected: true, label: 'Real Outlook (test@outlook.com) → Allowed' },
  { email: 'user@yahoo.com', expected: true, label: 'Real Yahoo (user@yahoo.com) → Allowed' },
  { email: 'demo@icloud.com', expected: true, label: 'Real iCloud (demo@icloud.com) → Allowed' },
  { email: 'invalid-email', expected: false, label: 'Email with wrong format → Rejected' }
];

let passed = 0;
let failed = 0;

testCases.forEach((tc) => {
  const result = validateEmail(tc.email);
  const isOk = result.valid === tc.expected;
  if (isOk) {
    console.log(`[PASS] ${tc.label} | valid=${result.valid}${result.error ? ' | error="' + result.error + '"' : ''}`);
    passed++;
  } else {
    console.error(`[FAIL] ${tc.label} | expected=${tc.expected}, got=${result.valid}`);
    failed++;
  }
});

console.log(`\nResults: ${passed} PASSED, ${failed} FAILED.`);
if (failed > 0) process.exit(1);
