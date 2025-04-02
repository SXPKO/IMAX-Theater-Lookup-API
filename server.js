const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const csv = require('csv-parser');
const { Client } = require('pg');
const theaterRouter = express.Router();
const { Pool } = require('pg');
const { db } = require('./firebase');
const crypto = require('crypto');
const readline = require('readline');
const request = require('request-promise');
const cheerio = require('cheerio');
const makeCsvWriter = require('csv-writer').createObjectCsvWriter;
const port = process.env.PORT || 3006;

//Loads the ChatGPT API key and the DB env variables from the .env file.
dotenv.config();

const app = express();

const OpenAI = require('openai');

//API key for ChatGPT.
const openAI = new OpenAI({
  apiKey:  process.env.OPENAI_API_KEY
});

const STRIPE_KEY = process.env.STRIPE_SK;
const stripe = require('stripe')(STRIPE_KEY)
const DOMAIN = 'http://localhost:3006';


//Pool object that uses the .env variables to connect to the Postgres database.
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASS,
  db_Port:  process.env.DB_PORT
});

//Config object for creating a new Client instance.
const config = {
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASS,
  port: process.env.DB_PORT,
};

const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');


//Middleware that limits the rate of API requests to 15 requests per 15 minute.
const imaxRateLimit = require('express-rate-limit');

const imaxLimiter = imaxRateLimit({
  windowMs:  15 * 60 * 1000, //Per 15 minutes.
  max: 15, //15 endpoint requests per 15 minutes.
  message: {
    error: 'You have exceeded the 15 endpoint requests within a 15 minute limit. Please wait for a while and then try calling again.',
  },
  handler: (req, res, next, options) => {
    console.error(`Rate limit exceeded: ${req.ip}`);
    res.status(options.statusCode).json(options.message);
  },
  standardHeaders: true,
  legacyHeaders: false,
  });

  

//Middleware that logs each API endpoint request.
const requestsLogger = (req, res, next) => {
  const loggingDetails = {
    method: req.method,
    url: req.originalUrl,
    params: req.params,
    query: req.query,
    body: req.body,
    timestamp: new Date().toISOString(),
  };

  //Saves logs to a file.
  const loggingFile = path.join(__dirname, './logs/request_logs.txt');
  const loggingEntry = `${JSON.stringify(loggingDetails)}\n`;
  fs.appendFile(loggingFile, loggingEntry, (err) => {
    if (err) {
      console.error('An error has occurred while trying to write the request to the log file:', err);
    }
  });

  next(); //Proceeds to the next piece of middleware.
};

//Function that generates a secure and unique API Key. One that has no issues with verification.
const generateApiKey = () => {
    const api_key = crypto.randomBytes(16).toString('hex').toUpperCase(); 
    if (!api_key || typeof api_key !== 'string' || api_key.trim() === '') {
      throw new Error('This generated API Key is invalid.');
    }

  return api_key;
};


//Middleware that enables use of various packages as well as the public folder.
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(express.static('images'));

//Result text that shows up on the default page/directory of the IMAX API.
app.get("/", (req, res) => {
    res.send("Welcome to the IMAX Theater Scraper! To obtain data, consult the documentation to use the specific endpoint you're looking for.");
  });


  //This route authenticates and verifies the customer's API Key. 
  //Using a Firebase DB record, this makes sure the key is valid and remains up to date.
  app.get('/apiKey', async (req, res) => {
    const { api_key } = req.query
    if (!api_key) { return res.sendStatus(403) }
    let payment_status, type
    const doc = await db.collection('api_keys').doc(api_key).get()
    if (!doc.exists) {
        res.status(403).send({ 'status': " Either this API Key doesnt't exist, or it's incorrect." })
    } else {
        const { status, type, stripeCustomerId } = doc.data()
        if (status === 'subscription') {
            payment_status = true
            const customer = await stripe.customers.retrieve(
                stripeCustomerId,
                { expand: ['subscriptions'] }
            )
            console.log(customer)

            let subscriptionId = customer?.subscriptions?.data?.[0]?.id
            console.log(subscriptionId)
            const subscription = await stripe.subscriptions.retrieve(subscriptionId)
            const itemID = subscription?.items?.data[0].id

            const record = stripe.subscriptionItems.createUsageRecord(
                itemID, {
                quantity: 1,
                timestamp: 'now',
                action: 'increment'
            }
            )
            console.log('A record for this API Key has just been made.')
        } else if (status > 0) {
            payment_status = true
            const data = {
                status: status - 1 
            }
            const dbResponse = await db.collection('api_keys').doc(api_key).set(data, { merge: true })
        }

    }
    if (payment_status) {
        res.status(200).send({ "message": " Your API Key has just been verified and created. Feel free to make some calls!" })
    } else {
        res.sendStatus(403)
    }
})

app.get('/check_status', async (req, res) => {
  const { api_key } = req.query
  const doc = await db.collection('api_keys').doc(api_key).get()
  if (!doc.exists) {
      res.status(400).send({ 'status': "This API Key doesn't exist." })
  } else {
      const { status } = doc.data()
      res.status(200).send({ 'status': status })
  }
})


  //Post endpoint request that creates a Stripe checkout session 
  //depending on whether the user picked the prepaid or subscription plan.
  app.post("/create-checkout-session/:product", async (req, res) => {
    const { product } = req.params
    let mode, price_ID, line_items, quantity_type


    if (product === 'sub') {
        price_ID = 'price_1QznuxBNSJn5qCnuJ8HCussh'
        mode = 'subscription'
        line_items = [
            {
                price: price_ID,
            }
        ]
        //Quantity_type is the API call quantity. It's indefinite
        //in the case of the subsription plan.
        quantity_type = 'subscription'
    } else if (product === 'prepaid') {
        price_ID = 'price_1QznP7BNSJn5qCnuVfiixRpN'
        mode = 'payment'
        line_items = [
            {
                price: price_ID,
                quantity: 1
            }
        ]
        //100 API calls for the prepaid plan.
        quantity_type = 100
    } else {
        return res.sendStatus(403)
    }

    //Generates new API Key to be saved to the Firebase DB.
    const createAPIKey = await generateApiKey(product)

    await db.collection('api_keys').doc(createAPIKey).set({
      type: product,
      status: quantity_type,
      createdAt: new Date().toISOString(),
    });


    //Initiates Stripe customer creation as well as the checkout session.
    const customer = await stripe.customers.create({
        metadata: {
            APIkey: createAPIKey
        }
    })

    const stripeCustomerId = customer.id
    const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        metadata: {
            APIkey: createAPIKey,
            payment_type: product
        },
        line_items: line_items,
        mode: mode,
        success_url: `${DOMAIN}/success.html?api_key=${createAPIKey}`,
        cancel_url: `${DOMAIN}/cancellation.html`,
    })
    console.log(session)

    //Creates a Firebase DB record.
    //Works in conjunction with webhook to lookup the API key 
    //entry, making sure the checkout info stays up to date.
    const data = {
        APIkey: createAPIKey,
        payment_type: product,
        stripeCustomerId,
        status: quantity_type 
    }
    const dbRes = await db.collection('api_keys').doc(createAPIKey).set(data, { merge: true })

    res.redirect(303, session.url)
    return quantity_type;
})

app.post('/stripe_webhook', (req, res) => {

})

//Endpoint that cancels a Stripe subscription plan when called.
app.get('/delete', async (req, res) => {
  const { api_key } = req.query

    //Retrieves the specific key from the Firebase API Key database.
  const doc = await db.collection('api_keys').doc(api_key).get()
  if (!doc.exists) {
     return res.status(400).send({ status: "This API Key doesn't exist." })  
    } 

    else {

      const { stripeCustomerId } = doc.data()
      try {
          //Retrieves the Stripe Customer and their subscription.
          const customer = await stripe.customers.retrieve(
              stripeCustomerId,
              { expand: ['subscriptions'] }
          )
          
          console.log(customer)

          //Retrieves the customer's subscription ID.
          let subscriptionId = customer?.subscriptions?.data?.[0].id

          //Deletes the customer's subscription ID from Stripe.
          stripe.subscriptions.cancel(subscriptionId)

          //Saves cancelled subscription changes to the Firebase DB.
          const data = {
              status: null //The cancelled subscription now has a value of null to match its status.
          }
          const dbRes = await db.collection('api_keys').doc(api_key).set(data, { merge: true })
        }
          catch (err) {
          console.error('An error has occurred while trying to cancel the subscription.')
          return res.sendStatus(500)
      }
      res.sendStatus(200)
    }
})

//Middleware fuction which validates API Keys in order for somebody to use the IMAX REST endpoints.
const apiKeyValidation = async (req, res, next) => {
  const api_key = req.headers['x-api-key']; //The API key passed in the request header.
  console.log('Incoming Header: ', req.headers);

  if (!api_key) {
    return res.status(401).json({ error: 'API Key is required in order to use this endpoint.' });
  }

  try {
    //Checks if the specific API Key exists in the Firebase database.
    const doc = await db.collection('api_keys').doc(api_key).get();
    if (!doc.exists) {
      return res.status(403).json({ error: 'This API Key is invalid.' })
    }

    //Retrieves the Firebase API Key details.
    const apiKeysData = doc.data();

    //Checks if the API Key is active. (Doesn't have a status of 'null')
    if (apiKeysData.status === null) {
      return res.status(403).json({ error: 'This is not an active API Key. You must have cancelled your subscription.' })
    }

    //Checks if the API Key isn't aa part of either payment plan.
    if (apiKeysData.payment_type !== 'sub' && apiKeysData.payment_type !== 'prepaid') {
      return res.status(403).json({ error: 'This is neither part of a prepaid or subscription plan.' })
    }

    //Attaches the API Key Firebase data to a request object for use in the IMAX endpoints.
    req.apiKeysData = apiKeysData;

    console.log('API Key validation passed. Proceeding to the next middleware or endpoint.');
    next(); //Proceeds to the next endpoint or middleware.
    console.log('This should not appear if next() works correctly.');
  } catch (error) {
    console.error('Error validating API Key:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

  //Function to scrape the IMAX Theater data from the LFExaminer site's theater lookup table.
  async function initialization() {
    const tableResult = await request.get("https://lfexaminer.com/theaters/");
    const $ = cheerio.load(tableResult);

    const imaxTheaters = [];

    //Loop that iterates through each table row and Scrapes the data from the table and stores it in an array of objects.
    $("#tablepress-12 > tbody > tr").each((index, element) => {
        if (index === 0) return true;
        const tds = $(element).find("td");
        const theaterID = $(tds[0]).text().trim() || '';
        const theaterCountry = $(tds[1]).text().trim() || '';
        const theaterCity = $(tds[2]).text().trim() || '';
        const theaterState = $(tds[3]).text().trim() || '';
        const theaterName = $(tds[4]).text().trim() || '';
        const theaterBrand = $(tds[5]).text().trim() || '';
        const theaterLease = $(tds[6]).text().trim() || '';
        const theaterFormat = $(tds[7]).text().trim() || '';
        const theaterDimension = $(tds[8]).text().trim() || '';
        const theaterScreenType = $(tds[9]).text().trim() || '';
        const theaterSeats = $(tds[10]).text().trim() || '';
        const theaterScreenSize = $(tds[11]).text().trim() || '';
        const theaterOpening = $(tds[12]).text().trim() || '';
        const theaterTable = { theaterID, theaterCountry, theaterCity, theaterState, theaterName, theaterBrand, theaterLease, theaterFormat, theaterDimension, theaterScreenType, theaterSeats, theaterScreenSize, theaterOpening };
      
        imaxTheaters.push(theaterTable);
    });
    //console.log(imaxTheaters);
    return imaxTheaters;
    res.json(imaxTheaters);

    // Creates a new CSV file detailing all the IMAX theaters using the data obtained from the website.
    const csvWriter = makeCsvWriter({
        path: 'theaters.csv',
        header: [
            { id: 'theaterID', title: 'ID' },
            { id: 'theaterCountry', title: 'Country' },
            { id: 'theaterCity', title: 'City' },
            { id: 'theaterState', title: 'State' },
            { id: 'theaterName', title: 'Organization' },
            { id: 'theaterBrand', title: 'Large Format Type' },
            { id: 'theaterLease', title: 'Leased By' },
            { id: 'theaterFormat', title: ' IMAX Format' },
            { id: 'theaterDimension', title: 'Screen Dimension' },
            { id: 'theaterScreenType', title: 'Screen Type' },
            { id: 'theaterSeats', title: 'Number of Seats' },
            { id: 'theaterScreenSize', title: 'Screen Size' },
            { id: 'theaterOpening', title: 'Opening Date' }
        ]
    });

   //Writes the obtained data to the CSV file.
    csvWriter.writeRecords(imaxTheaters)
        .then(() => {
            console.log('The CSV file was written successfully');
        })
        .catch(error => {
            console.error('Error writing CSV file:', error);
        });

   }

//Function to save the theater array object to the Postgres database.
async function saveToDB(imaxTheaters) {
    const client = new Client(config);
  
    try {
      await client.connect();
  
      //Creates the new Postgres Table to store the IMAX Theater data.
      const dbCreationQuery = `
      DROP TABLE IF EXISTS imax_theaters;
        CREATE TABLE IF NOT EXISTS imax_theaters (
          theaterID SERIAL PRIMARY KEY,
            theaterCountry TEXT DEFAULT '',
            theaterCity TEXT DEFAULT '',
            theaterState TEXT DEFAULT '',
            theaterName TEXT DEFAULT '',
            theaterBrand TEXT DEFAULT '',
            theaterLease TEXT DEFAULT '',
            theaterFormat TEXT DEFAULT '',
            theaterDimension TEXT DEFAULT '',
            theaterScreenType TEXT DEFAULT '',
            theaterSeats TEXT DEFAULT '',
            theaterScreenSize TEXT DEFAULT '',
            theaterOpening TEXT DEFAULT ''
        );
      `;
      await client.query(dbCreationQuery);

        //Inserts theater data into the database.
        for (const theater of imaxTheaters) {
          const {
            theaterCountry,
            theaterCity,
            theaterState,
            theaterName,
            theaterBrand,
            theaterLease,
            theaterFormat,
            theaterDimension,
            theaterScreenType,
            theaterSeats,
            theaterScreenSize,
            theaterOpening
          } = theater;
  
          const insertionQuery = `
          INSERT INTO imax_theaters (
            theaterCountry, theaterCity, theaterState, theaterName, theaterBrand, theaterLease, theaterFormat, theaterDimension, theaterScreenType, theaterSeats, theaterScreenSize, theaterOpening
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `;
        const values = [
          theaterCountry, theaterCity, theaterState, theaterName, theaterBrand, theaterLease, theaterFormat, theaterDimension, theaterScreenType, theaterSeats, theaterScreenSize, theaterOpening
        ];

        await client.query(insertionQuery, values);
      }

      console.log('Theater data has been inserted into the database.');
      await client.end();
} catch (error) {
  console.error('Error saving data to the database:', error);
  await client.end();
}
}

  (async () => {
    try {
      const imaxTheaters = await initialization();
      //console.log("Saved Data:", savedData);
  
      //Saves the inserted data to the Postgres database.
      await saveToDB(imaxTheaters);
      console.log("IMAX Theater Data saved to the database.");
    } catch (error) {
      console.error("Error during scraping:", error);
      process.on('uncaughtException', function (err) {
        console.log(err);
    }); 
    }
  })();

  

//Creates a new Winston logger that logs the IMAX API endpoint requests to a file.
const transport = new winston.transports.DailyRotateFile({
  filename: 'logs/request_logs.txt',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d'
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [transport]
});

//Asychronous function that calls the ChatGPT API to provide descriptions for the theaters.
async function getDescriptionFromChatGPT(data) {
  const url = "https://api.openai.com/v1/chat/completions";
  try {
    console.log('Requesting description for data:', data); 


    //Creates a simplified and well-formed prompt.
    const prompt = `
      Provide a description for the following theater data:
      ${JSON.stringify(data, null, 2)}
    `;

    const response = await axios.post(
      url,
      {
        model: "gpt-4o", 
        messages: [{ role: "user", content: prompt }],
        max_tokens: 16000, 
        temperature: 1.0,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, // Use the environment variable
        },
      }
    );
    console.log('Response from ChatGPT:', response.data);
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error getting description from ChatGPT:', error);
    return 'Description not available.';
  }
}

//Applies the API Key Verification middleware to all IMAX endpoints in this router.
theaterRouter.use(apiKeyValidation);
//Applies the request logger to the theater endpoint router.
theaterRouter.use(requestsLogger);

//REST API Endpoints.

  //Creates a new IMAX theater in the database.
  theaterRouter.post('/create', async (req, res) => {
    const {
      theaterCountry,
      theaterCity,
      theaterState,
      theaterName,
      theaterBrand,
      theaterLease,
      theaterFormat,
      theaterDimension,
      theaterScreenType,
      theaterSeats,
      theaterScreenSize,
      theaterOpening
    } = req.body;
  
    //Logs the request body for debugging.
    console.log('Request body:', req.body);
  
    try {
      const result = await pool.query(
        `INSERT INTO imax_theaters (
          theaterCountry, theaterCity, theaterState, theaterName, theaterBrand, theaterLease, theaterFormat, theaterDimension, theaterScreenType, theaterSeats, theaterScreenSize, theaterOpening
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [theaterCountry, theaterCity, theaterState, theaterName, theaterBrand, theaterLease, theaterFormat, theaterDimension, theaterScreenType, theaterSeats, theaterScreenSize, theaterOpening]
      );
      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Error creating IMAX theater:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });
  
  //Reads through all theaters in the Postgres database.
  theaterRouter.get('/list', async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM imax_theaters');
      res.status(200).json(result.rows);
    } catch (error) {
      console.error('Error reading theaters:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });
  
  //Reads a single IMAX theater by its ID.
  theaterRouter.get('/id/:theaterID', async (req, res) => {
    const { theaterID } = req.params;
  
    try {
      const result = await pool.query('SELECT * FROM imax_theaters WHERE theaterID = $1', [theaterID]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Theater not found.' });
      }
  
      //Calls the ChatGPT API to provide a description for the returned theater.
      const descriptions = await Promise.all(result.rows.map(async (row) => {
        const description = await getDescriptionFromChatGPT(row);
        return { ...row, description };
      }));
  
      res.status(200).json(descriptions);
    } catch (error) {
      console.error('Error reading theater:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });
  
  //Updates an IMAX theater by its ID.
  theaterRouter.put('/id/:theaterID', async (req, res) => {
    const { theaterID } = req.params;
    const {
      theaterCountry,
      theaterCity,
      theaterState,
      theaterName,
      theaterBrand,
      theaterLease,
      theaterFormat,
      theaterDimension,
      theaterScreenType,
      theaterSeats,
      theaterScreenSize,
      theaterOpening
    } = req.body;
  
    try {
      const result = await pool.query(
        `UPDATE imax_theaters SET
          theaterCountry = $1,
          theaterCity = $2,
          theaterState = $3,
          theaterName = $4,
          theaterBrand = $5,
          theaterLease = $6,
          theaterFormat = $7,
          theaterDimension = $8,
          theaterScreenType = $9,
          theaterSeats = $10,
          theaterScreenSize = $11,
          theaterOpening = $12
        WHERE theaterID = $13 RETURNING *`,
        [theaterCountry, theaterCity, theaterState, theaterName, theaterBrand, theaterLease, theaterFormat, theaterDimension, theaterScreenType, theaterSeats, theaterScreenSize, theaterOpening, theaterID]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Theater not found' });
      }
      res.status(200).json(result.rows[0]);
    } catch (error) {
      console.error('Error updating theater:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });
  
  //Reads through IMAX theaters by their particular format.
  theaterRouter.get('/format/:theaterFormat', async (req, res) => {
      const { theaterFormat } = req.params;
    
      try {
        const result = await pool.query('SELECT * FROM imax_theaters WHERE theaterFormat = $1', [theaterFormat]);
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'No theaters found with the specified format.' });
        }
        res.status(200).json(result.rows);
      } catch (error) {
        console.error('Error reading theaters by format:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });
  
    //Reads through IMAX theaters by their country.
  theaterRouter.get('/country/:theaterCountry', async (req, res) => {
      const { theaterCountry } = req.params;
    
      try {
        const result = await pool.query('SELECT * FROM imax_theaters WHERE theaterCountry = $1', [theaterCountry]);
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'No theaters found with the specified country.' });
        }
        res.status(200).json(result.rows);
      } catch (error) {
        console.error('Error reading theaters by country:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });
  
    //Reads through IMAX theaters by their city.
  theaterRouter.get('/city/:theaterCity', async (req, res) => {
      const { theaterCity } = req.params;
    
      try {
        const result = await pool.query('SELECT * FROM imax_theaters WHERE theaterCity = $1', [theaterCity]);
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'No theaters found with the specified city.' });
        }
  
        //Calls the ChatGPT API to provide a description for the returned theater(s).
      const descriptions = await Promise.all(result.rows.map(async (row) => {
        const description = await getDescriptionFromChatGPT(row);
        return { ...row, description };
      }));
  
      res.status(200).json(descriptions);
      } catch (error) {
        console.error('Error reading theaters by city:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });
  
    //Reads through IMAX theaters by state.
  theaterRouter.get('/state/:theaterState', async (req, res) => {
      const { theaterState } = req.params;
    
      try {
        const result = await pool.query('SELECT * FROM imax_theaters WHERE theaterState = $1', [theaterState]);
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'No theaters found with the specified state.' });
        }
      res.status(200).json(result.rows);
      } catch (error) {
        console.error('Error reading theaters by state:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });
  
    //Reads a single IMAX theater by it's name/organization.
  theaterRouter.get('/name/:theaterName', async (req, res) => {
      const { theaterName } = req.params;
    
      try {
        const result = await pool.query('SELECT * FROM imax_theaters WHERE theaterName = $1', [theaterName]);
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'No theaters found with the specified name.' });
        }
  
        const descriptions = await Promise.all(result.rows.map(async (row) => {
        const description = await getDescriptionFromChatGPT(row);
        return { ...row, description };
      }));
  
      res.status(200).json(descriptions);
      } catch (error) {
        console.error('Error reading theaters by name/organization:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });
  
    //Reads through IMAX theaters by the number of seats in the theater.
  theaterRouter.get('/seats/:theaterSeats', async (req, res) => {
      const { theaterSeats } = req.params;
    
      try {
        const result = await pool.query('SELECT * FROM imax_theaters WHERE theaterSeats = $1', [theaterSeats]);
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'No theaters found with the specified number of seats.' });
        }
  
      res.status(200).json(result.rows);
  
      } catch (error) {
        console.error('Error reading theaters by seats:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });
  
    //Reads through theaters by their brand of large format.
  theaterRouter.get('/brand/:theaterBrand', async (req, res) => {
      const { theaterBrand } = req.params;
    
      try {
        const result = await pool.query('SELECT * FROM imax_theaters WHERE theaterBrand = $1', [theaterBrand]);
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'No theaters found with the specified brand.' });
        }
        res.status(200).json(result.rows);
      } catch (error) {
        console.error('Error reading theaters by brand:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });
  
  
    //Reads through IMAX theaters by screen dimension(2D/3D).
  theaterRouter.get('/dimension/:theaterDimension', async (req, res) => {
      const { theaterDimension } = req.params;
    
      try {
        const result = await pool.query('SELECT * FROM imax_theaters WHERE theaterDimension = $1', [theaterDimension]);
        if (result.rows.length === 0) {
          return res.status(404).json({ error: 'No theaters found with the specified screen dimension.' });
        }
        res.status(200).json(result.rows);
      } catch (error) {
        console.error('Error reading theaters by screen dimension:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });
  
    //Reads through IMAX theaters by their screen type.
    //For example, one can look up all dome theaters.
  theaterRouter.get('/type/:theaterScreenType', async (req, res) => {
    const { theaterScreenType } = req.params;
  
    try {
      const result = await pool.query('SELECT * FROM imax_theaters WHERE theaterScreenType = $1', [theaterScreenType]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'No theaters found with the specified screen type.' });
      }
  
      res.status(200).json(result.rows);
    } catch (error) {
      console.error('Error reading theaters by screen type:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });
  
  //Reads through IMAX theaters by their opening date.
  theaterRouter.get('/opening/:theaterOpening', async (req, res) => {
    const { theaterOpening } = req.params;
  
    try {
      const result = await pool.query('SELECT * FROM imax_theaters WHERE theaterOpening = $1', [theaterOpening]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'No theaters found with the specified opening date.' });
      }
  
      //Calls the ChatGPT API to provide a description for the returned theater(s).
      const descriptions = await Promise.all(result.rows.map(async (row) => {
        const description = await getDescriptionFromChatGPT(row);
        return { ...row, description };
      }));
  
      res.status(200).json(descriptions);
    } catch (error) {
      console.error('Error reading theaters by opening date:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });


//Middleware that uses the theater endpoint router along with its limiter. 
app.use('/theaters', imaxLimiter, theaterRouter);


app.listen(port, () => console.log('Server has started on port: ${port}'))