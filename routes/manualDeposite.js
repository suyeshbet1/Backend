const express = require('express');

const router = express.Router();

router.post('/', (req, res) => {
  res.json({ feature: 'manual deposit', message: 'Demo route for manual deposits.' });
});

module.exports = router;
