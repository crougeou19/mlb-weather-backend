FROM node:20-alpine

WORKDIR /app

COPY . .

RUN npm install --ignore-scripts

RUN npx tsc --project tsconfig.json

EXPOSE 3000

CMD ["npm", "start"]
