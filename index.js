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

// Зареждане на променливи от .env файл (напр. R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY и др.)
dotenv.config();

// Създаване на Express приложение
const app = express();
// Middleware за парсване на JSON тела на заявки
app.use(express.json());

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


// Дефиниране на порта, на който сървърът ще слуша
const PORT = process.env.PORT || 3000;
// Стартиране на сървъра
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));