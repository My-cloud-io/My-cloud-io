const app = require("../server");

// Vercel Node function: keep request parsing under the app's control.
module.exports = app;
module.exports.config = {
  api: {
    bodyParser: false
  }
};
