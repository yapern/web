// Vite selects the local Worker in development and the Yapern API in builds.
export const messageBoardConfig = {
  apiOrigin: import.meta.env?.DEV ? "http://localhost:8787" : "https://api.yapern.com",
  table: "messages",
};
