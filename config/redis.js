const Redis = require("ioredis");
require('dotenv').config();

const redisConfig = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASS,
};

const redis = new Redis(redisConfig);
const publisher = new Redis(redisConfig);
const subscriber = new Redis(redisConfig);

module.exports = {
  redis,
  publisher,
  subscriber
};