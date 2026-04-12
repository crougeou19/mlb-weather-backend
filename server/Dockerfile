FROM node:20-alpine

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm install

COPY . .
RUN npx tsc --project tsconfig.json

EXPOSE 3000

CMD ["npm", "start"]
