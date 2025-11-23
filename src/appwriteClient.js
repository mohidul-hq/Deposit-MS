// src/appwriteClient.js
import axios from "axios";

const appwriteClient = axios.create({
  baseURL: import.meta.env.VITE_APPWRITE_ENDPOINT, // change if self-hosted
  headers: {
    "X-Appwrite-Project": import.meta.env.VITE_APPWRITE_PROJECT_ID, // Vite example
    "Content-Type": "application/json",
  },
  withCredentials: true, // important if you're using sessions/cookies auth
});

export default appwriteClient;
