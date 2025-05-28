// Импортиране на необходимите вградени модули на Node.js
const fs = require('fs');
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
const { Pool, Connection } = require('pg'); // Импортиране на pg Pool

// Зареждане на променливи от .env файл (напр. R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY и др.)
dotenv.config();

// Създаване на Express приложение
const app = express();
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
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
  });

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
 * Очаква JSON тяло със следните полета:
 * - userId (string, задължително)
 * - input_image_prompt (string, опционално)
 * - input_image_style1 (string[], опционално, масив от стрингове)
 * - input_image_style2 (string[], опционално, масив от стрингове)
 * - input_image_url (string, опционално)
 * - parameters (object, опционално, JSON обект)
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
        const messagePayload = {
          job_id: newJobId,
          input_image_prompt: input_image_prompt || null,
          input_image_style1: input_image_style1 && input_image_style1.length > 0 ? input_image_style1 : null,
          input_image_style2: input_image_style2 && input_image_style2.length > 0 ? input_image_style2 : null,
        };
        try {
          rabbitmqChannel.publish(
            RABBITMQ_EXCHANGE_NAME,
            RABBITMQ_ROUTING_KEY,
            Buffer.from(JSON.stringify(messagePayload)),
            { persistent: true } // Гарантира, че съобщението ще оцелее при рестарт на RabbitMQ сървъра
          );
          console.log(`Message sent to RabbitMQ for job_id: ${newJobId}`);
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


// Дефиниране на порта, на който сървърът ще слуша
const PORT = process.env.PORT || 3000;
// Стартиране на сървъра
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- Грациозно спиране ---
// async function gracefulShutdown() {
//   console.log('Attempting to gracefully shut down...');

//   if (rabbitmqConnection) {
//     try {
//       console.log('Closing RabbitMQ connection...');
//       await rabbitmqConnection.close();
//       console.log('RabbitMQ connection closed.');
//     } catch (err) {
//       console.error('Error closing RabbitMQ connection:', err.message);
//     }
//   }

//   // Тук можете да добавите и затваряне на PostgreSQL pool-а, ако е необходимо
//   // await pgPool.end();
//   // console.log('PostgreSQL pool closed.');

//   process.exit(0);
// }

// process.on('SIGINT', gracefulShutdown); // Прихващане на Ctrl+C
// process.on('SIGTERM', gracefulShutdown); // Прихващане на сигнал за терминиране