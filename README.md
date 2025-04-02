# IMAX Theater Lookup API

## Author Details
* Author: Harrison Thacker
* Email: harrison.johnson.thacker@gmail.com
* Version Of Application: 1.0
* Period Of Development: Jan - March 2025

## Overview
Node.js API that retrieves data from all IMAX theaters around the world. Has endpoints to also add new theaters or even make edits to existing ones.

Made in Node.js, Express, with a PostgreSQL database backend. Uses Firebase to store and keep track of API Key records. Runs within a Docker Container. API Keys(Prepaid plan or Subscription plan) are purchased through Stripe.

With the LFExaminer site being out of publication and no longer updating its database of IMAX theaters or other premium large format theaters, I decided to make an API that offers a solution. The theater lookup contains every single prior entry found on the original site, and endpoint calls can be used to add new theaters or provide updates to existing ones. This will allow a more up-to-date and complete profile of IMAX theaters around the world, with a plethora of details for each location. One can consult the theaters.csv file plus the documentation for assistance making an API call.

In addition, this API can look up IMAX theaters all over the world by using endpoints to search through various criteria. One can search for a specific theater by its name or ID. And if someone wanted to lookup all 1.43:1 locations that offer both 15/70 film projection and GT Laser(DL2), there's an endpoint to search for theaters by their format. Other search options include: Country, City, State, Large Format Type(Could be other brands such as Barco), the number of seats, 2D/3D projection capability, Flat/Dome screens, and the Opening Date.

Certain endpoints also make use of the ChatGPT API. Using the data obtained from the returned DB rows, ChatGPT provides a description for that particular theater, detailing an overview that sums up all that locations attributes and what might make it a standout IMAX experience. This is valuable for someone who may be eyeing a specific location wanting to know more about it. 

 ## Subscription Notes
The Prepaid plan is for one month only and isn't renewable. For a renewable payment, try the Subscription plan which renews monthly via Stripe. You'll be able to make unlimited API calls this way. Usage is metered so the monthly cost is dependant on how many calls are made.

To cancel your subscription, go to the home page(API Key Purchase), and type in your API Key in the verification section to authenticate it. Your key should then be verified, and you'll get to see the status of your subscription.

Down below is a button to cancel the subscription. Careful, because once clicked, your subscription is inactive, and you will no longer be able to make calls.

For assistance and questions with anything, please reach out to harrison.johnson.thacker@gmail.com

## Documentation Link
https://gist.github.com/0451hthack/840d7a06fae7dcb61ee301484e2655f3


## Railway Link 
