import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 빌드는 GitHub Pages 하위 경로(https://suimaire.github.io/1-9-check/) 기준이고, dev 서버는 항상 '/'.
// 다른 경로에 올릴 때는 VITE_BASE_PATH로 덮어쓴다. 라우팅은 HashRouter라 새로고침해도 404가 나지 않는다.
export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE_PATH || (command === 'build' ? '/1-9-check/' : '/'),
  plugins: [react()],
  server: { port: Number(process.env.PORT) || 5173 },
}));
