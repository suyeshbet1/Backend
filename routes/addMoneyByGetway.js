const express = require('express');

const router = express.Router();

router.post('/initiate', (req, res) => {
  res.json({ feature: 'add money by gateway', message: 'Demo route for initiating payment.' });
});

module.exports = router;
