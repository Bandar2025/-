const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  // تهيئة النافذة الرئيسية
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'نظام محمصة القهوة',
    webPreferences: {
      // تفعيل Node Integration للسماح باستخدام require في ملفات renderer (للتبسيط في هذا المشروع)
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    }
  });

  // تحميل ملف الواجهة
  mainWindow.loadFile('index.html');

  // فتح أدوات المطور (اختياري للصيانة)
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});