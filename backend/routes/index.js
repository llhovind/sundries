'use strict';

const express = require('express');
const router = express.Router();

/* GET home page. */
router.get('/', (req, res) => {
    res.send('Store API');
});

module.exports = router;
