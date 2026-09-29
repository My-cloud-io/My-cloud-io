const app = require("../server");

// Let the Express route use express.raw() for the binary upload endpoint.
module.exports = app;
module.exports.config = {
  api: {
    bodyParser: false
  }
};
