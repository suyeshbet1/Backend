const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ feature: 'game chart', message: 'Demo route for retrieving game chart data.' });
});

module.exports = router;
