const express = require('express');

const router = express.Router();

router.post('/', (req, res) => {
  res.json({ feature: 'user withdrawal', message: 'Demo route for user withdrawals.' });
});

module.exports = router;
