FROM node:18.3.0-alpine3.14

WORKDIR /user/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3006
CMD ["npm", "run", "dev"]
