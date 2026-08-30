const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "khalf9hussein2@gmail.com",
    pass: "nmai hmwn gjlr kbot",
  },
});

const sendVerificationEmail = async (toEmail, otp) => {
  // OTP service disabled
  return true;
};

module.exports = sendVerificationEmail;