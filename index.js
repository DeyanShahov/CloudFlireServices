// Импортиране на необходимите вградени модули на Node.js
const fs = require('fs');
const crypto = require('crypto'); // За генериране на UUID
const path = require('path');
const { execSync } = require('child_process'); // За синхронно изпълнение на команди

/**
 * @function ensureDependencies
 * @description Проверява дали всички зависимости, дефинирани в package.json, са инсталирани.
 * Ако липсват зависимости, функцията се опитва да ги инсталира чрез 'npm install'.
 * След успешна инсталация, скриптът трябва да бъде рестартиран, за да се заредят новите модули.
 */
function ensureDependencies() {
    console.log('Checking for required dependencies...');
    let packageJson;

    // Път до package.json файла
    try {
        const packageJsonPath = path.join(__dirname, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            console.error('Error: package.json not found in the current directory.');
            console.log('Please ensure you are in the project root and package.json exists.');
            process.exit(1);
        }
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    } catch (error) {
        console.error('Error reading or parsing package.json:', error);
        process.exit(1); // Изход, ако не можем да прочетем package.json
    }
    
    // Извличане на списъка със зависимости от package.json
    const dependencies = packageJson.dependencies || {};
    const allRequiredPackages = { ...dependencies };

    const requiredPackageNames = Object.keys(allRequiredPackages);
    // Ако няма дефинирани зависимости, няма какво да се проверява
    if (requiredPackageNames.length === 0) {
        console.log('No dependencies listed in package.json.');
        return; // Няма какво да се проверява
    }

    let missingDependencies = false;
    // Проверка за всяка зависимост дали е налична
    for (const pkgName of requiredPackageNames) {
        try {
            // require.resolve() хвърля грешка, ако модулът не може да бъде намерен
            require.resolve(pkgName);
        } catch (e) { // NOSONAR
            // Грешката тук означава, че модулът не е намерен.
            // Ще се опитаме да инсталираме всички зависимости по-долу.
            // Умишлено не прекъсваме цикъла, за да съберем всички липсващи (макар че npm install ще ги инсталира всички).
            console.warn(`Dependency ${pkgName} is missing.`);
            missingDependencies = true;
        }
    }

    // Ако има липсващи зависимости, опит за инсталация
    if (missingDependencies) {
        console.log('Attempting to install missing dependencies using "npm install"...');
        try {
            // Синхронно изпълнение на 'npm install'. 'stdio: "inherit"' показва изхода в конзолата.
            execSync('npm install', { stdio: 'inherit' });
            console.log('\nDependencies installation process finished.');
            console.log('IMPORTANT: Please restart the script for the new dependencies to be loaded.');
            process.exit(0); // Успешен изход, за да се подсети потребителят да рестартира
        } catch (error) {
            console.error('\nFailed to install dependencies automatically.', error.message);
            console.error('Please try running "npm install" manually.');
            process.exit(1); // Изход при грешка по време на инсталацията
        }
    } else {
        console.log('All required dependencies are present.');
    }
}

ensureDependencies(); // Проверка и инсталация на зависимости

// Импортиране на външни модули (след като ensureDependencies евентуално ги е инсталирал)
const express = require('express');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const dotenv = require('dotenv');
const multer = require('multer');
const amqp = require('amqplib'); // Импортиране на amqplib за RabbitMQ
const { createClient: createRedisClient } = require('redis'); // Импортиране на redis клиент
const { Pool, Connection } = require('pg'); // Импортиране на pg Pool

// Зареждане на променливи от .env файл (напр. R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY и др.)
dotenv.config();

// Създаване на Express приложение
const app = express();
// Middleware за парсване на URL-encoded тела на заявки (за form-data, което не е файл)
app.use(express.urlencoded({ extended: true }));

// Middleware за парсване на JSON тела на заявки
app.use(express.json());

// --- RabbitMQ Конфигурация и Свързване ---
const RABBITMQ_URL = process.env.RABBITMQ_URL; // Стандартен AMQP порт, 15672 е за management UI
const RABBITMQ_CLIENT_PROVIDED_NAME = process.env.RABBITMQ_CLIENT_PROVIDED_NAME; // Име на клиента, което ще се показва в RabbitMQ UI
const RABBITMQ_EXCHANGE_NAME = process.env.RABBITMQ_EXCHANGE_NAME; // Име на exchange-а, по подразбиране
const RABBITMQ_EXCHANGE_TYPE = process.env.RABBITMQ_EXCHANGE_TYPE; // Тип на exchange-а
const RABBITMQ_ROUTING_KEY = process.env.RABBITMQ_ROUTING_KEY; // Routing key за свързване на exchange-а с queue-то
const RABBITMQ_QUEUE_NAME = process.env.RABBITMQ_QUEUE_NAME; // Име на queue-то, което ще се използва

// Проверка дали всички необходими RabbitMQ променливи са зададени
if (!RABBITMQ_URL || !RABBITMQ_CLIENT_PROVIDED_NAME || !RABBITMQ_EXCHANGE_NAME || !RABBITMQ_EXCHANGE_TYPE || !RABBITMQ_ROUTING_KEY || !RABBITMQ_QUEUE_NAME) {
    console.error('RabbitMQ configuration is incomplete. Please check your .env file.');
    process.exit(1);
}


let rabbitmqChannel = null;
let rabbitmqConnection = null;

async function connectRabbitMQ() {
    try {
        console.log('Attempting to connect to RabbitMQ...');
        rabbitmqConnection = await amqp.connect(RABBITMQ_URL, { clientProperties: { connection_name: RABBITMQ_CLIENT_PROVIDED_NAME } });
        console.log('Successfully connected to RabbitMQ.');

        rabbitmqConnection.on('error', (err) => {
            console.error('RabbitMQ connection error:', err.message);
            rabbitmqChannel = null; // Нулиране на канала
            // Опит за повторно свързване след известно време
        });

        rabbitmqConnection.on('close', () => {
            console.warn('RabbitMQ connection closed. Attempting to reconnect in 5 seconds...');
            rabbitmqChannel = null;
            rabbitmqConnection = null;
            setTimeout(connectRabbitMQ, 5000);
        });

        rabbitmqChannel = await rabbitmqConnection.createChannel();
        await rabbitmqChannel.assertExchange(RABBITMQ_EXCHANGE_NAME, RABBITMQ_EXCHANGE_TYPE, { durable: true });
        await rabbitmqChannel.assertQueue(RABBITMQ_QUEUE_NAME, { durable: true });
        await rabbitmqChannel.bindQueue(RABBITMQ_QUEUE_NAME, RABBITMQ_EXCHANGE_NAME, RABBITMQ_ROUTING_KEY);
        console.log('RabbitMQ channel, exchange, queue, and binding are set up.');
    } catch (error) {
        console.error('Failed to connect to RabbitMQ or setup channel:', error.message);
        rabbitmqChannel = null;
        rabbitmqConnection = null;
        console.log('Retrying RabbitMQ connection in 5 seconds...');
        setTimeout(connectRabbitMQ, 5000); // Опит за повторно свързване след 5 секунди
    }
}

// Инициализиране на връзката с RabbitMQ при стартиране на приложението
connectRabbitMQ();

// --- Redis Конфигурация и Свързване ---
const REDIS_URL = process.env.REDIS_URL; // напр. rediss://default:yourpassword@yourhost.upstash.io:port

if (!REDIS_URL) {
    console.warn('REDIS_URL is not defined in .env. Redis functionality will be unavailable.');
}

let redisClient = null;

async function connectRedis() {
    if (!REDIS_URL) {
        console.warn('Cannot connect to Redis: REDIS_URL not set.');
        return;
    }
    try {
        console.log('Attempting to connect to Redis...');
        redisClient = createRedisClient({
            url: REDIS_URL
        });

        redisClient.on('error', (err) => {
            console.error('Redis Client Error:', err);
            // Клиентът на redis v4 автоматично ще опита да се свърже отново при определени грешки.
            // Може да се наложи допълнителна логика тук в зависимост от типа грешка.
        });

        redisClient.on('connect', () => console.log('Connecting to Redis...'));
        redisClient.on('ready', () => console.log('Successfully connected to Redis and client is ready.'));
        redisClient.on('reconnecting', () => console.log('Reconnecting to Redis...'));

        await redisClient.connect();
    } catch (error) {
        console.error('Failed to connect to Redis:', error.message);
        redisClient = null; // Нулиране на клиента при неуспешна първоначална връзка
        // Може да се добави логика за повторен опит тук, ако е необходимо,
        // въпреки че клиентът има вградени механизми за повторно свързване.
    }
}

// Инициализиране на връзката с Redis при стартиране на приложението
connectRedis();

// --- Redis Set Имена за Статуси на Задачи ---
const JOB_STATUS_PENDING = 'jobs:status:pending';
// const JOB_STATUS_PROCESSING = 'jobs:status:processing'; // Управлява се от външен worker
const JOB_STATUS_READY = 'jobs:status:ready'; // Задачи, готови за изтегляне от диспечера
// const JOB_STATUS_FAILED = 'jobs:status:failed'; // Управлява се от външен worker
const JOB_STATUS_DISPATCHER_CACHE_PROCESSING = 'jobs:status:dispatcher_cache_processing'; // Задачи, кеширани от диспечера и чакащи клиент


// Конфигуриране на PostgreSQL Pool
const pgPool = new Pool({
  user: process.env.PGUSER, // Потребител за базата данни
  host: process.env.PGHOST, // Хост на базата данни
  database: process.env.PGDATABASE, // Име на базата данни
  password: process.env.PGPASSWORD, // Парола за базата данни
  port: parseInt(process.env.PGPORT, 10), // Порт на базата данни
});

// Конфигуриране на S3 клиента за връзка с Cloudflare R2
const s3Client = new S3Client({
    region: "auto", // R2 не използва региони по традиционния AWS начин, "auto" е подходящо
    endpoint: process.env.R2_ENDPOINT, // URL на R2 endpoint-а
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID, // Ключ за достъп
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    signatureVersion: 'v4',
});

// Конфигуриране на Multer за обработка на файлове в паметта (до 10 файла едновременно)
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage, // Файловете се съхраняват в паметта като Buffer обекти
    limits: { files: 10 } // Ограничение до 10 файла на заявка
});

// --- Диспечерски Механизъм за Готови Задачи ---
const readyJobsForClientCache = new Map(); // Локален кеш: jobId -> { r2Key, userId, createdAt, expiresAt }
//const DISPATCHER_POLL_INTERVAL = parseInt(process.env.DISPATCHER_POLL_INTERVAL, 10) || 5000; // ms
const DISPATCHER_CACHE_ITEM_TTL = parseInt(process.env.DISPATCHER_CACHE_ITEM_TTL, 10) || (60 * 60 * 1000); // 1 час по подразбиране

// --- Конфигурация за режими на диспечера ---
// Стойностите се четат от .env или се използват стойности по подразбиране
const DISPATCHER_ACTIVE_POLL_INTERVAL = parseInt(process.env.DISPATCHER_ACTIVE_POLL_INTERVAL, 10) || 5000; // 5 секунди по подразбиране
const DISPATCHER_IDLE_POLL_INTERVAL = parseInt(process.env.DISPATCHER_IDLE_POLL_INTERVAL, 10) || 60000; // 1 минута по подразбиране
const DISPATCHER_ACTIVE_MODE_DURATION = parseInt(process.env.DISPATCHER_ACTIVE_MODE_DURATION, 10) || 30000; // 30 секунди по подразбиране


// --- Състояние на диспечера ---
let currentDispatcherPollInterval = DISPATCHER_ACTIVE_POLL_INTERVAL; // Първоначално стартира в активен режим
let dispatcherIntervalId = null;
let activityTimeoutId = null; // Таймер за връщане в IDLE режим
let isDispatcherInActiveMode = false; // Флаг за текущия режим (ще стане true при първото активиране)

// Декларираме runDispatcherCycle тук, за да може да се използва от функциите за управление на режимите,
// преди нейната пълна дефиниция по-долу в кода.
async function runDispatcherCycle() { /* ... тялото на функцията е дефинирано по-долу ... */ }


/**
 * @async
 * @function streamToBase64
 * @description Асинхронна помощна функция за преобразуване на ReadableStream в Base64 кодиран низ.
 * @param {ReadableStream} stream - Потокът от данни за преобразуване.
 * @returns {Promise<string>} Promise, който се разрешава с Base64 кодирания низ.
 */
const streamToBase64 = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });

function startOrRestartDispatcherInterval() {
    if (dispatcherIntervalId) {
        clearInterval(dispatcherIntervalId);
        dispatcherIntervalId = null;
    }
    // Проверка дали redisClient е готов преди да стартираме интервала
    if (redisClient && redisClient.isReady) {
        dispatcherIntervalId = setInterval(runDispatcherCycle, currentDispatcherPollInterval);
        // Логването за стартиране/смяна на интервала се случва във функциите за смяна на режим
    } else {
        console.warn('Dispatcher: Cannot start interval, Redis client not ready.');
    }
}

function switchToIdleMode() {
    // Преминаваме в Idle режим само ако сме били активни или интервалът не е вече Idle
    if (isDispatcherInActiveMode || currentDispatcherPollInterval !== DISPATCHER_IDLE_POLL_INTERVAL) {
        console.log(`Dispatcher: Switching to Idle Mode. Polling interval will be: ${DISPATCHER_IDLE_POLL_INTERVAL / 1000}s.`);
        currentDispatcherPollInterval = DISPATCHER_IDLE_POLL_INTERVAL;
        isDispatcherInActiveMode = false;
        startOrRestartDispatcherInterval();
    }
    if (activityTimeoutId) {
        clearTimeout(activityTimeoutId);
        activityTimeoutId = null;
    }
}

function activateWorkingMode() {
    if (activityTimeoutId) { // Нулиране на предходен таймер за активност
        clearTimeout(activityTimeoutId);
    }

    if (!isDispatcherInActiveMode || currentDispatcherPollInterval !== DISPATCHER_ACTIVE_POLL_INTERVAL) {
        console.log(`Dispatcher: Switching to Active Mode. Polling interval will be: ${DISPATCHER_ACTIVE_POLL_INTERVAL / 1000}s.`);
        currentDispatcherPollInterval = DISPATCHER_ACTIVE_POLL_INTERVAL;
        isDispatcherInActiveMode = true;
        startOrRestartDispatcherInterval();
    }
    console.log(`Dispatcher: Activity detected. Resetting active mode timer to ${DISPATCHER_ACTIVE_MODE_DURATION / 1000}s. Current mode: Active (polling every ${currentDispatcherPollInterval / 1000}s).`);
    activityTimeoutId = setTimeout(switchToIdleMode, DISPATCHER_ACTIVE_MODE_DURATION);
}


/**
 * @async
 * @function streamToBuffer
 * @description Асинхронна помощна функция за преобразуване на ReadableStream в Buffer.
 * @param {ReadableStream} stream - Потокът от данни за преобразуване.
 * @returns {Promise<Buffer>} Promise, който се разрешава с Buffer обекта.
 */
const streamToBuffer = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });


// Помощна функция за пълно почистване на данни за дадена задача
async function performFullCleanup(jobId, r2Key, bucketName, redis, s3, localCache) {
    try {
        console.log(`Job ${jobId}: Initiating full cleanup. R2 Key (if any): ${r2Key}`);

        // 1. Изтриване от R2, ако е предоставен r2Key
        if (r2Key && bucketName) {
            try {
                const deleteR2Params = {
                    Bucket: bucketName,
                    Delete: { Objects: [{ Key: r2Key }], Quiet: false }
                };
                await s3.send(new DeleteObjectsCommand(deleteR2Params));
                console.log(`Job ${jobId}: Successfully deleted R2 object: ${r2Key}`);
            } catch (r2Error) {
                console.error(`Job ${jobId}: Error deleting R2 object ${r2Key}:`, r2Error);
                // Продължаваме с почистването на Redis, дори ако R2 изтриването е неуспешно
            }
        }

        // 2. Изтриване от Redis (основния hash и всички релевантни status sets)
        const multi = redis.multi();
        multi.del(jobId); // Изтриване на основния job hash
        multi.sRem(JOB_STATUS_PENDING, jobId); // В случай, че е заседнал
        multi.sRem(JOB_STATUS_READY, jobId);
        multi.sRem(JOB_STATUS_DISPATCHER_CACHE_PROCESSING, jobId);
        // multi.sRem(JOB_STATUS_FAILED, jobId); // Ако worker-ите добавят към специфичен failed set
        await multi.exec();
        console.log(`Job ${jobId}: Successfully deleted Redis hash and removed from status sets.`);

        // 3. Изтриване от локалния кеш на диспечера
        if (localCache.has(jobId)) {
            localCache.delete(jobId);
            console.log(`Job ${jobId}: Removed from dispatcher's local cache.`);
        }
    } catch (cleanupError) {
        console.error(`Job ${jobId}: CRITICAL - Failed during full cleanup. R2 Key: ${r2Key}. Error:`, cleanupError);
    }
}

// --- ЕНДПОЙНТИ ---

/**
 * @route POST /upload
 * @description Ендпойнт за качване на един или множество файлове към R2.
 * Очаква 'userId' в тялото на заявката (form-data) и файлове под полето 'imageFiles'.
 * Файловете се записват в R2 под ключ с формат: 'userId/originalFilename'.
 */
app.post('/upload', upload.array('imageFiles'), async (req, res) => {
  const { userId } = req.body; // Идентификатор на потребителя, изпратен като form-data поле
  const files = req.files; // Масив от файлове, обработени от Multer
  
  try {
    // Валидация на входните данни
    if (!userId) {
      return res.status(400).json({ error: 'userId is required in the request body.' });
    }
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    const bucketName = process.env.R2_BUCKET_NAME;
    if (!bucketName) {
        console.error('R2_BUCKET_NAME is not set in .env');
        return res.status(500).json({ error: 'Server configuration error: Bucket name not set.' });
    }

    const uploadResults = [];
    // Асинхронно качване на всеки файл
    const uploadPromises = files.map(async (file) => {
      const s3Key = `${userId}/${file.originalname}`; // Структура: потребител/име-на-файл

      // Параметри за PutObjectCommand
      const uploadParams = {
        Bucket: bucketName,
        Key: s3Key,
        Body: file.buffer, // Съдържанието на файла от Multer (memoryStorage)
        ContentType: file.mimetype // Типът на съдържанието на файла
      };
      
      const command = new PutObjectCommand(uploadParams);
      await s3Client.send(command);
      // Връщане на информация за успешно качения файл
      return { originalName: file.originalname, key: s3Key, userId: userId };
    });

    const results = await Promise.all(uploadPromises);
    uploadResults.push(...results);
    
    res.status(200).json({ success: true, uploadedFiles: uploadResults });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload image(s)', details: error.message });
  }
});

/**
 * @route GET /images/:userId
 * @description Ендпойнт за извличане на всички изображения за даден потребител.
 * Изображенията се връщат като JSON масив, където всяко изображение е Base64 кодирано.
 * След успешно изпращане на отговора, всички извлечени изображения за този потребител се изтриват от R2.
 * @param {string} req.params.userId - Идентификаторът на потребителя, чиито изображения да бъдат извлечени.
 */
app.get('/images/:userId', async (req, res) => {
  const { userId } = req.params;
  const bucketName = process.env.R2_BUCKET_NAME;

  if (!bucketName) {
    console.error('R2_BUCKET_NAME is not set in .env');
    return res.status(500).json({ error: 'Server configuration error: Bucket name not set.' });
  }

  try {
    // Стъпка 1: Извличане на списък с всички обекти (файлове) за дадения потребител от R2.
    // Използва се Prefix, за да се филтрират обектите в "директорията" на потребителя.
    const listParams = {
      Bucket: bucketName,
      Prefix: `${userId}/`
    };
    const listedObjects = await s3Client.send(new ListObjectsV2Command(listParams));

    // Ако няма намерени обекти или Contents е празен, връщаме 404.
    if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
      return res.status(404).json({ message: `No images found for user ${userId}.` });
    }

    // Събиране на ключовете на намерените обекти.
    const imageKeys = listedObjects.Contents.map(item => item.Key).filter(key => key); // Добавяме .filter(key => key) за всеки случай
    const imageDataArray = [];

    // Стъпка 2: За всеки намерен ключ, извличане на данните на обекта.
    for (const key of imageKeys) {
      // if (!key) continue; // Вече филтрирано по-горе
      const getParams = { Bucket: bucketName, Key: key };
      const objectData = await s3Client.send(new GetObjectCommand(getParams));
      const base64Data = await streamToBase64(objectData.Body); // Преобразуване на потока в Base64
      // Извличане на името на файла от пълния ключ
      const filename = key.substring(key.lastIndexOf('/') + 1);
      imageDataArray.push({
        filename: filename,
        contentType: objectData.ContentType,
        data: base64Data
      });
    }

    // Стъпка 3: Изпращане на масива с Base64 кодираните изображения към клиента.
    res.status(200).json(imageDataArray);

    // Стъпка 4: Изтриване на обектите от R2 СЛЕД успешно изпращане на отговора.
    // Тази част се изпълнява след като отговорът е изпратен (или поне изпращането е започнало).
    // Това е "fire and forget" операция спрямо текущата заявка на клиента,
    // но е важно да се логва успех/неуспех на сървъра.
    if (imageKeys.length > 0) {
      const deleteParams = {
        Bucket: bucketName,
        Delete: {
          Objects: imageKeys.map(key => ({ Key: key })),
          Quiet: false // We want to know about errors
        }
      };
      try {
        const deleteResult = await s3Client.send(new DeleteObjectsCommand(deleteParams));
        console.log(`Successfully deleted ${deleteResult.Deleted?.length || 0} images for user ${userId}.`);
        if (deleteResult.Errors && deleteResult.Errors.length > 0) {
            console.error(`Errors deleting images for user ${userId}:`, deleteResult.Errors);
        }
      } catch (deleteError) {
        console.error(`Failed to initiate batch delete for user ${userId}:`, deleteError);
      }
    }

  } catch (error) {
    console.error(`Error processing images for user ${userId}:`, error);
    // Ако хедърите все още не са изпратени, можем да изпратим отговор за грешка.
    if (!res.headersSent) {
        if (error.name === 'NoSuchKey') { // Should be caught by ListObjectsV2 generally
            res.status(404).json({ error: `An image was not found during processing for user ${userId}.` });
        } else {
            res.status(500).json({ error: 'Failed to retrieve or process images.', details: error.message });
        }
    }
  }
});

/**
 * @route GET /image/raw/:key(*)
 * @description Ендпойнт за извличане на суровите данни на единично изображение по неговия пълен ключ.
 * Този ендпойнт е полезен за директна визуализация в Postman или браузър.
 * НЕ изтрива файла след изтегляне.
 * @param {string} req.params.key - Пълният ключ на обекта в R2 (напр. "userId/filename.jpg").
 * Знакът (*) в пътя позволява наклонени черти (/) в параметъра 'key'.
 */
app.get('/image/raw/:key(*)', async (req, res) => {
  const { key } = req.params;
  const bucketName = process.env.R2_BUCKET_NAME;

  if (!bucketName) {
    console.error('R2_BUCKET_NAME is not set in .env');
    return res.status(500).json({ error: 'Server configuration error: Bucket name not set.' });
  }

  if (!key) {
    return res.status(400).json({ error: 'Image key is required.' });
  }

  try {
    const getParams = {
      Bucket: bucketName,
      Key: key
    };
    const objectData = await s3Client.send(new GetObjectCommand(getParams));
    // Преобразуване на потока в Buffer, за да може да се изпрати директно
    const imageBody = await streamToBuffer(objectData.Body); 

    // Задаване на правилния Content-Type, за да може Postman/браузърът да визуализира изображението
    res.set('Content-Type', objectData.ContentType);
    res.send(imageBody); // Изпращане на суровите бинарни данни на изображението

  } catch (error) {
    console.error(`Error fetching raw image ${key}:`, error);
    if (!res.headersSent) {
      if (error.name === 'NoSuchKey') {
        res.status(404).send(`Image with key ${key} not found.`);
      } else {
        res.status(500).json({ error: 'Failed to retrieve image.', details: error.message });
      }
    }
  }
});

/**
 * @route POST /jobs
 * @description Ендпойнт за създаване на нова задача (job) в PostgreSQL базата данни.
 * @description Създаване на нова задача (job) в RabbitMQ брокаера на данни.
 * Очаква JSON тяло със следните полета:
 * - userId (string, задължително)
 * - input_image_prompt (string, опционално)
 * - input_image_style1 (string[], опционално, масив от стрингове)
 * - input_image_style2 (string[], опционално, масив от стрингове)
 * - input_image_url (string, опционално)
 * - parameters (object, опционално, JSON обект)
 * - При успешно създаване на job, се изпраща съобщение към RabbitMQ с детайли за задачата.
 * @returns {object} JSON обект с информация за създадената задача, включително jobId.
 */
app.post('/jobs', async (req, res) => {
  const {
    userId,
    input_image_prompt,
    input_image_style1,
    input_image_style2,
    input_image_url,
    parameters
  } = req.body;

  // Валидация на задължителните полета
  if (!userId) {
    return res.status(400).json({ error: 'userId is required.' });
  }

  // Статусът по подразбиране за нова задача е 'pending'
  const status = 'pending';

  // Подготовка на стойностите за заявката, като се обработват опционалните полета
  // За масиви, ако са празни или undefined, ще се запишат като празни масиви в PostgreSQL (TEXT[])
  // За JSONB, ако е undefined, ще се запише като NULL или празен обект, в зависимост от предпочитанията
  const queryValues = [
    userId, // $1
    input_image_prompt || null, // $2  
    input_image_style1 && input_image_style1.length > 0 ? input_image_style1 : null, // $3 (PostgreSQL TEXT[])
    input_image_style2 && input_image_style2.length > 0 ? input_image_style2 : null, // $4 (PostgreSQL TEXT[])
    input_image_url || null, // $5
    status, // $6
    parameters || {} // $7 (PostgreSQL JSONB)
  ];

  const insertQuery = `
    INSERT INTO jobs2 (user_id, input_image_prompt, input_image_style1, input_image_style2, input_image_url, status, parameters)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING job_id; -- Връща ID-то на новосъздадения запис
  `;

  try {
    const result = await pgPool.query(insertQuery, queryValues);
    const newJobId = result.rows[0]?.job_id;
    // res.status(201).json({ 
    //     success: true, 
    //     message: 'Job created successfully.', 
    //     jobId: newJobId 
    // });

    if (newJobId) {
      // Изпращане на съобщение към RabbitMQ след успешен запис в PostgreSQL
      if (rabbitmqChannel) {
        const baseMessagePayload = {
          job_id: newJobId,
          input_image_prompt: input_image_prompt || null,
          input_image_style1: input_image_style1 && input_image_style1.length > 0 ? input_image_style1 : null,
          input_image_style2: input_image_style2 && input_image_style2.length > 0 ? input_image_style2 : null,
        };

        // Извличане на специфични параметри, ако съществуват в req.body.parameters
        const extractedParams = {};
        if (parameters) { // 'parameters' е от req.body
            const parameterKeysToExtract = ['steps', 'cfg', 'sampler_name', 'scheduler', 'ckpt_name', 'negative_prompt', 'positive_prompt', 'batch_size'];
            for (const key of parameterKeysToExtract) {
                if (Object.prototype.hasOwnProperty.call(parameters, key)) {
                    extractedParams[key] = parameters[key];
                }
            }
        }

        const finalMessagePayload = { ...baseMessagePayload, ...extractedParams };

        try {
          rabbitmqChannel.publish(
            RABBITMQ_EXCHANGE_NAME,
            RABBITMQ_ROUTING_KEY,
            Buffer.from(JSON.stringify(finalMessagePayload)),
            { persistent: true } // Гарантира, че съобщението ще оцелее при рестарт на RabbitMQ сървъра
          );
          console.log(`Message sent to RabbitMQ for job_id: ${newJobId} with payload:`, finalMessagePayload);
        } catch (rabbitError) {
          console.error(`Failed to send message to RabbitMQ for job_id: ${newJobId}`, rabbitError);
          // Тук може да се добави логика за обработка на грешката при изпращане към RabbitMQ,
          // например, маркиране на задачата като "pending_notification" или опит за повторно изпращане.
        }
      } else {
        console.warn(`Job ${newJobId} created, but RabbitMQ channel is not available. Message not sent.`);
      }
      res.status(201).json({ success: true, message: 'Job created successfully.', jobId: newJobId });
    } else {
      // Това не би трябвало да се случи, ако заявката е успешна и RETURNING работи
      res.status(500).json({ error: 'Failed to create job or retrieve job ID.' });
    }

  } catch (error) {
    console.error('Error creating job in PostgreSQL:', error);
    res.status(500).json({ error: 'Failed to create job.', details: error.message });
  }
});

/**
 * @route POST /jobsRedis
 * @description Ендпойнт за създаване на нова задача (job) в Redis.
 * Очаква JSON тяло със следните полета:
 * - userId (string, задължително)
 * - input_image_prompt (string, опционално)
 * - input_image_style1 (string[], опционално, масив от стрингове)
 * - input_image_style2 (string[], опционално, масив от стрингове)
 * - input_image_url (string, опционално)
 * - parameters (object, опционално, JSON обект)
 * При успешно създаване на job в Redis, се изпраща съобщение към RabbitMQ с детайли за задачата.
 * @returns {object} JSON обект с информация за създадената задача, включително jobId.
 */
app.post('/jobsRedis', async (req, res) => {
    const {
        userId,
        input_image_prompt,
        input_image_style1,
        input_image_style2,
        input_image_url,
        parameters
    } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId is required.' });
    }

    if (!redisClient || !redisClient.isReady) {
        console.error('Redis client is not connected or not ready.');
        return res.status(503).json({ error: 'Service unavailable: Redis connection error.' });
    }

    const jobId = crypto.randomUUID(); // Генериране на уникален ID за задачата
    const status = 'pending';
    const createdAt = new Date().toISOString();

    const jobData = {
        job_id: jobId,
        user_id: userId,
        input_image_prompt: input_image_prompt || null,
        // За масиви и обекти е добре да ги JSON.stringify, ако ще се съхраняват като стрингове в Redis Hash полета
        input_image_style1: input_image_style1 && input_image_style1.length > 0 ? JSON.stringify(input_image_style1) : null,
        input_image_style2: input_image_style2 && input_image_style2.length > 0 ? JSON.stringify(input_image_style2) : null,
        input_image_url: input_image_url || null,
        status: status,
        parameters: parameters ? JSON.stringify(parameters) : null,
        created_at: createdAt
    };

    // Премахване на null полета, за да не се записват изрично в Redis, ако не е нужно
    const jobDataToStore = Object.fromEntries(Object.entries(jobData).filter(([_, v]) => v !== null));

    try {        
        const redisKey = jobId;

        // Използване на MULTI за атомарност на операциите
        const multi = redisClient.multi();
        multi.hSet(redisKey, jobDataToStore); // Запис на данните за задачата в Hash
        multi.sAdd(JOB_STATUS_PENDING, jobId); // Добавяне на jobId към Set-а за pending задачи
        
        // Можете да зададете и TTL (време на живот) за самия Hash ключ, ако задачите са временни
        // await redisClient.expire(redisKey, 3600); // Например, изтича след 1 час

        await multi.exec();

        console.log(`Job ${jobId} created successfully in Redis and added to '${JOB_STATUS_PENDING}'.`);

        // Изпращане на съобщение към RabbitMQ
        if (rabbitmqChannel) {
            const baseMessagePayload = {
                job_id: jobId,
                input_image_prompt: input_image_prompt || null,
                // За RabbitMQ изпращаме оригиналните масиви, не JSON стрингове
                input_image_style1: input_image_style1 && input_image_style1.length > 0 ? input_image_style1 : null,
                input_image_style2: input_image_style2 && input_image_style2.length > 0 ? input_image_style2 : null,
            };

            // Извличане на специфични параметри, ако съществуват в req.body.parameters
            const extractedParams = {};
            if (parameters) { // 'parameters' е от req.body
                const parameterKeysToExtract = ['steps', 'cfg_scale', 'sampler_name', 'scheduler', 'ckpt_name', 'negative_prompt', 'positive_prompt', 'batch_size'];
                for (const key of parameterKeysToExtract) {
                    if (Object.prototype.hasOwnProperty.call(parameters, key)) {
                        extractedParams[key] = parameters[key];
                    }
                }
            }

            const finalMessagePayload = { ...baseMessagePayload, ...extractedParams };

            try {
                rabbitmqChannel.publish(
                    RABBITMQ_EXCHANGE_NAME,
                    RABBITMQ_ROUTING_KEY,
                    Buffer.from(JSON.stringify(finalMessagePayload)),
                    { persistent: true }
                );
                console.log(`Message sent to RabbitMQ for job_id: ${jobId} with payload:`, finalMessagePayload);
            } catch (rabbitError) {
                console.error(`Failed to send message to RabbitMQ for job_id: ${jobId}`, rabbitError);
                // Обмислете логика за компенсация или маркиране на задачата
            }
        } else {
            console.warn(`Job ${jobId} created in Redis, but RabbitMQ channel is not available. Message not sent.`);
        }

        // Активиране на "работещ" режим на диспечера, тъй като е създадена нова задача
        activateWorkingMode();

        res.status(201).json({ success: true, message: 'Job created successfully in Redis.', jobId: jobId });

    } catch (error) {
        console.error('Error creating job in Redis:', error);
        res.status(500).json({ error: 'Failed to create job in Redis.', details: error.message });
    }
});


/**
 * @route GET /jobResult/:jobId
 * @description Ендпойнт за проверка на статуса на задача и извличане на резултата (изображение).
 * Клиентите правят polling към този ендпойнт.
 * @param {string} req.params.jobId - ID на задачата.
 */
app.get('/jobResult', async (req, res) => { // Промяна: премахване на :jobId от пътя
    const { jobId } = req.query; // Промяна: извличане на jobId от req.query
    const bucketName = process.env.R2_BUCKET_NAME;

    if (!jobId) {
        return res.status(400).json({ error: 'jobId query parameter is required.' });
    }

    if (!redisClient || !redisClient.isReady) {
        return res.status(503).json({ error: 'Service unavailable: Redis connection error.' });
    }
    if (!bucketName) {
        console.error('R2_BUCKET_NAME is not set in .env for /jobResult');
        return res.status(500).json({ error: 'Server configuration error: Bucket name not set.' });
    }

    try {
        // При всяка заявка за резултат, активираме "работещ" режим на диспечера
        activateWorkingMode();

        let jobData = await redisClient.hGetAll(jobId); // Вземане на данните за задачата веднъж
      
        // --- Step 1: Check local cache first ---
        const cachedJob = readyJobsForClientCache.get(jobId);

        if (cachedJob && cachedJob.r2Key) {
            console.log(`Job ${jobId}: Found in local dispatcher cache with R2 key: ${cachedJob.r2Key}. Attempting to fetch and send.`);
            try {
                const getParams = { Bucket: bucketName, Key: cachedJob.r2Key };
                const objectData = await s3Client.send(new GetObjectCommand(getParams));
                const imageBody = await streamToBuffer(objectData.Body);
                const base64Data = imageBody.toString('base64');

                const finalResponse = {
                    status: "completed",
                    image_data_base64: base64Data,
                    image_type: objectData.ContentType || "application/octet-stream"
                };

                res.status(200).json(finalResponse);
                console.log(`Job ${jobId} (R2 Key: ${cachedJob.r2Key}) from cache successfully sent to client.`);
                // Cleanup after successful send from cache
                await performFullCleanup(jobId, cachedJob.r2Key, bucketName, redisClient, s3Client, readyJobsForClientCache);
            } catch (fetchError) {
                if (fetchError.name === 'NoSuchKey') {
                    console.warn(`Job ${jobId}: (From Cache) R2 object not found (NoSuchKey) for key ${cachedJob.r2Key}. Cleaning up job.`);
                    if (!res.headersSent) {
                        res.status(404).json({ status: 'error', message: `Image for job ${jobId} (key: ${cachedJob.r2Key}) not found in storage. The job record is being cleaned up.` });
                    }
                    await performFullCleanup(jobId, cachedJob.r2Key, bucketName, redisClient, s3Client, readyJobsForClientCache);
                } else {
                    console.error(`Job ${jobId}: (From Cache) Error fetching/processing image from R2 (Key: ${cachedJob.r2Key}):`, fetchError);
                    if (!res.headersSent) {
                        res.status(500).json({ status: 'error', message: 'Failed to retrieve image data from cache source due to storage error.', details: fetchError.message });
                    }
                    // DO NOT cleanup here for other R2 errors. Let client retry. Job stays in cache until TTL.
                }
            }
            return; // Important: exit after handling cached job
        }
       
        // --- Step 2: If not in cache, or cache entry was invalid, query Redis ---
        console.log(`Job ${jobId}: Not found in local cache or cache entry invalid. Querying Redis.`);
        jobData = await redisClient.hGetAll(jobId); // Вземане на данните за задачата от Redis

        // Case 1 (from Redis): Job not found in Redis
        if (!jobData || Object.keys(jobData).length === 0) {
            return res.status(404).json({ status: 'not_found', message: 'Job not found in Redis.' });
        }

        // Case 2 (from Redis): Job is 'ready' and has output_r2_key
        if (jobData.status === 'ready' && jobData.output_r2_key) { // NOSONAR
            const r2Key = jobData.output_r2_key; // NOSONAR
            console.log(`Job ${jobId}: Found in Redis as 'ready' with R2 key: ${r2Key}. Attempting to fetch and send.`);
            try {
                const getParams = { Bucket: bucketName, Key: r2Key };
                const objectData = await s3Client.send(new GetObjectCommand(getParams));
                const imageBody = await streamToBuffer(objectData.Body);
                const base64Data = imageBody.toString('base64');

                const finalResponse = {
                    status: "completed",
                    image_data_base64: base64Data,
                    image_type: objectData.ContentType || "application/octet-stream" // Използване на реалния ContentType
                };

                res.status(200).json(finalResponse);
                console.log(`Job ${jobId} (R2 Key: ${r2Key}) from Redis successfully sent to client.`);
                // Почистване след успешно изпращане
                await performFullCleanup(jobId, r2Key, bucketName, redisClient, s3Client, readyJobsForClientCache);
            } catch (fetchError) {
                if (fetchError.name === 'NoSuchKey') {
                    console.warn(`Job ${jobId}: (From Redis) R2 object not found (NoSuchKey) for key ${r2Key}. Job status was 'ready'. Cleaning up job.`);
                    if (!res.headersSent) {
                        res.status(404).json({ status: 'error', message: `Image for job ${jobId} (key: ${r2Key}) not found in storage. The job record is being cleaned up.` });
                    }
                    // await performFullCleanup(jobId, null, bucketName, redisClient, s3Client, readyJobsForClientCache); // r2Key е null, тъй като не е намерен
                //} else {
                    // console.error(`Job ${jobId}: Error fetching/processing image from R2 (Key: ${r2Key}):`, fetchError);
                    await performFullCleanup(jobId, r2Key, bucketName, redisClient, s3Client, readyJobsForClientCache);
                } else {
                    console.error(`Job ${jobId}: (From Redis) Error fetching/processing image from R2 (Key: ${r2Key}):`, fetchError);                  
                    if (!res.headersSent) {
                        res.status(500).json({ status: 'error', message: 'Failed to retrieve image data from Redis source due to storage error.', details: fetchError.message });
                    }
                    // DO NOT cleanup here for other R2 errors. Job remains 'ready' in Redis. Client can retry.
                    // При други грешки при извличане, може да не искаме да чистим веднага, за да позволим евентуален повторен опит или инспекция.
                }
            }
            return;
        }

        // Case 3 (from Redis): Job is 'pending' or 'processing'
        if (jobData.status === 'pending' || jobData.status === 'processing') {
            return res.status(202).json({ status: jobData.status, message: 'Job is still being processed.' });
        }

        // Случай 4: Задачата е 'failed'
        if (jobData.status === 'failed') {
            res.status(200).json({ status: 'failed', message: jobData.error_message || 'Job processing failed.' });
            console.log(`Job ${jobId}: Reported 'failed' status to client (from Redis). Initiating cleanup.`);
            await performFullCleanup(jobId, null, bucketName, redisClient, s3Client, readyJobsForClientCache); // Няма R2 ключ за неуспешни задачи
            return;
        }

        // Случай 5: Задачата е 'ready', но липсва output_r2_key (неконсистентно състояние)
        if (jobData.status === 'ready' && !jobData.output_r2_key) {
            console.warn(`Job ${jobId} is 'ready' but has no 'output_r2_key'. Cleaning up as inconsistent.`);
            if (!res.headersSent) {
                 res.status(500).json({ status: 'error', message: 'Job is in an inconsistent ready state (missing output key). Job is being cleaned up.' });
            }
            await performFullCleanup(jobId, null, bucketName, redisClient, s3Client, readyJobsForClientCache);
            return;
        }

        // Случай 6: Други статуси или неизвестно състояние
        console.log(`Job ${jobId}: Status is '${jobData.status || 'unknown'}' and not handled by specific cases.`);
        return res.status(200).json({ status: jobData.status || 'unknown', message: 'Job status is unknown or in an unexpected state.' });

    } catch (error) { // Общ error handler за ендпойнта
        console.error(`Error processing /jobResult for ${jobId}:`, error);
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: 'Failed to retrieve job result due to a server error.', details: error.message });
        }
    }
});

// --- Диспечерска Логика ---
async function runDispatcherCycle() {
    if (!redisClient || !redisClient.isReady) {
        console.warn('Dispatcher: Redis client not ready. Skipping cycle.');
        return;
    }
    // console.log('Dispatcher: Running cycle...');

    try {
        const jobIdsInReadySet = await redisClient.sMembers(JOB_STATUS_READY);

        if (jobIdsInReadySet && jobIdsInReadySet.length > 0) {
            console.log(`Dispatcher: Found ${jobIdsInReadySet.length} job(s) in '${JOB_STATUS_READY}' set. IDs: ${jobIdsInReadySet.join(', ')}`);
        } else {
            // Можете да добавите лог и за случаите, когато няма готови задачи, ако е необходимо
            // console.log(`Dispatcher: No jobs found in '${JOB_STATUS_READY}' set during this cycle.`);
        }
        for (const jobId of jobIdsInReadySet) {
            if (readyJobsForClientCache.has(jobId)) { // Вече е в локалния кеш
                await redisClient.sMove(JOB_STATUS_READY, JOB_STATUS_DISPATCHER_CACHE_PROCESSING, jobId); // Увери се, че е в правилния Set
                continue;
            }

            const jobData = await redisClient.hGetAll(jobId);
            if (jobData && jobData.status === 'ready' && jobData.output_r2_key) {
                const moved = await redisClient.sMove(JOB_STATUS_READY, JOB_STATUS_DISPATCHER_CACHE_PROCESSING, jobId);
                if (moved) {
                    readyJobsForClientCache.set(jobId, {
                        r2Key: jobData.output_r2_key,
                        userId: jobData.user_id,
                        createdAt: Date.now(),
                        expiresAt: Date.now() + DISPATCHER_CACHE_ITEM_TTL
                    });
                    console.log(`Dispatcher: Job ${jobId} moved from '${JOB_STATUS_READY}' to cache and '${JOB_STATUS_DISPATCHER_CACHE_PROCESSING}'.`);
                } else {
                     // Може да се случи, ако друг инстанс го е взел или статусът се е променил.
                     // Ако вече е в JOB_STATUS_DISPATCHER_CACHE_PROCESSING, това е ОК.
                    if (await redisClient.sIsMember(JOB_STATUS_DISPATCHER_CACHE_PROCESSING, jobId) && !readyJobsForClientCache.has(jobId)) {
                         readyJobsForClientCache.set(jobId, { // Добави в локалния кеш, ако липсва
                            r2Key: jobData.output_r2_key, userId: jobData.user_id, createdAt: Date.now(), expiresAt: Date.now() + DISPATCHER_CACHE_ITEM_TTL
                        });
                    }
                }
            } else if (jobData && jobData.status !== 'ready') {
                console.warn(`Dispatcher: Job ${jobId} in '${JOB_STATUS_READY}' but Hash status is '${jobData.status}'. Removing from '${JOB_STATUS_READY}'.`);
                await redisClient.sRem(JOB_STATUS_READY, jobId);
            } else if (!jobData || Object.keys(jobData).length === 0) {
                console.warn(`Dispatcher: Job ${jobId} in '${JOB_STATUS_READY}' but no Hash data. Removing from '${JOB_STATUS_READY}'.`);
                await redisClient.sRem(JOB_STATUS_READY, jobId);
            }
        }
    } catch (error) {
        console.error('Dispatcher: Error during cycle:', error);
    }

    // Почистване на локалния кеш от изтекли елементи
    const now = Date.now();
    for (const [jobId, jobDetails] of readyJobsForClientCache.entries()) {
        if (now > jobDetails.expiresAt) {
            try {
                // Връщане обратно в JOB_STATUS_READY, за да може да бъде обработен отново или изтеглен директно
                const movedBack = await redisClient.sMove(JOB_STATUS_DISPATCHER_CACHE_PROCESSING, JOB_STATUS_READY, jobId);
                readyJobsForClientCache.delete(jobId);

                if (movedBack) {
                    console.log(`Dispatcher: Job ${jobId} TTL expired in cache, moved back to '${JOB_STATUS_READY}'.`);
                } else {
                    // Проверка дали задачата все още съществува, ако sMove е неуспешен
                    const jobExists = await redisClient.exists(jobId);
                    if (!jobExists) {
                        console.log(`Dispatcher: Job ${jobId} (TTL expired) no longer exists in Redis (likely processed and deleted by /jobResult). Removed from local cache.`);
                    } else {
                        console.log(`Dispatcher: Job ${jobId} TTL expired in cache. Could not move from '${JOB_STATUS_DISPATCHER_CACHE_PROCESSING}' (maybe already fetched or not there, but still exists in Redis). Removed from local cache.`);
                    }
                }
            } catch (err) {
                console.error(`Dispatcher: Error during TTL cleanup for job ${jobId}:`, err);
            }
        }
    }
}

// Стартиране на диспечера, когато Redis е готов
redisClient.on('ready', () => { // Преместено от connectRedis функцията, за да е сигурно, че redisClient е дефиниран
    console.log('Successfully connected to Redis and client is ready.');
    activateWorkingMode(); // Диспечерът стартира в "работещ" режим
});

// Дефиниране на порта, на който сървърът ще слуша
const PORT = process.env.PORT || 3000;
// Стартиране на сървъра
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- Грациозно спиране ---
async function gracefulShutdown() {
  console.log('Attempting to gracefully shut down...');

  if (activityTimeoutId) {
    clearTimeout(activityTimeoutId);
    console.log('Dispatcher activity timer cleared.');
  }

  if (dispatcherIntervalId) {
    clearInterval(dispatcherIntervalId);
    console.log('Dispatcher service stopped.');
  }

  if (rabbitmqConnection) {
    try {
      console.log('Closing RabbitMQ connection...');
      await rabbitmqConnection.close();
      console.log('RabbitMQ connection closed.');
    } catch (err) {
      console.error('Error closing RabbitMQ connection:', err.message);
    }
  }

  if (redisClient && redisClient.isReady) { // Проверка дали клиентът е свързан преди да се опитаме да го затворим
    try {
      console.log('Closing Redis connection...');
      await redisClient.quit(); // или redisClient.disconnect() в зависимост от нуждите
      console.log('Redis connection closed.');
    } catch (err) {
      console.error('Error closing Redis connection:', err.message);
    }
  }

  // Тук можете да добавите и затваряне на PostgreSQL pool-а, ако е необходимо
  if (pgPool) {
      try {
        console.log('Closing PostgreSQL pool...');
        await pgPool.end();
        console.log('PostgreSQL pool closed.');
      } catch (err) {
        console.error('Error closing PostgreSQL pool:', err.message);
      }
  }

  process.exit(0);
}

process.on('SIGINT', gracefulShutdown); // Прихващане на Ctrl+C
process.on('SIGTERM', gracefulShutdown); // Прихващане на сигнал за терминиране