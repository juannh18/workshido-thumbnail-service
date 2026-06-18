const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const cors = require('cors');
const { exec } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// CORS — solo acepta peticiones de workshido.com
app.use(cors({
  origin: ['https://workshido.com', 'https://workshido.netlify.app']
}));

// Multer — archivos en memoria temporal
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB máx
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'workshido-thumbnail' }));

// Endpoint principal
app.post('/generate-thumbnail', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const tmpDir = os.tmpdir();
  const ext = path.extname(req.file.originalname).toLowerCase();
  const baseName = `ws-${Date.now()}`;
  const inputPath = path.join(tmpDir, `${baseName}${ext}`);
  const outputPath = path.join(tmpDir, `${baseName}.webp`);

  try {
    // Guardar archivo temporalmente
    fs.writeFileSync(inputPath, req.file.buffer);

    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
      // Imagen: redimensionar directamente con Sharp
      await sharp(inputPath)
        .resize(300, 420, { fit: 'cover', position: 'top' })
        .webp({ quality: 85 })
        .toFile(outputPath);

    } else if (ext === '.pdf') {
      // PDF: extraer primera página con pdftoppm (parte de poppler)
      const pdfPngPath = path.join(tmpDir, baseName);
      await runCommand(`pdftoppm -png -f 1 -l 1 -r 150 "${inputPath}" "${pdfPngPath}"`);
      
      // El archivo generado se llama baseName-1.png
      const generatedPng = `${pdfPngPath}-1.png`;
      await sharp(generatedPng)
        .resize(300, 420, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
        .webp({ quality: 85 })
        .toFile(outputPath);

      // Limpiar PNG temporal
      if (fs.existsSync(generatedPng)) fs.unlinkSync(generatedPng);

    } else if (ext === '.docx' || ext === '.doc') {
      // DOCX: convertir a PDF con LibreOffice, luego extraer página 1
      await runCommand(`libreoffice --headless --convert-to pdf --outdir "${tmpDir}" "${inputPath}"`);
      
      const pdfPath = path.join(tmpDir, `${baseName}.pdf`);
      if (!fs.existsSync(pdfPath)) throw new Error('LibreOffice conversion failed');

      const pdfPngPath = path.join(tmpDir, `${baseName}-thumb`);
      await runCommand(`pdftoppm -png -f 1 -l 1 -r 150 "${pdfPath}" "${pdfPngPath}"`);

      const generatedPng = `${pdfPngPath}-1.png`;
      await sharp(generatedPng)
        .resize(300, 420, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
        .webp({ quality: 85 })
        .toFile(outputPath);

      // Limpiar temporales
      if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
      if (fs.existsSync(generatedPng)) fs.unlinkSync(generatedPng);

    } else {
      return res.status(400).json({ error: 'Unsupported file type: ' + ext });
    }

    // Subir miniatura a Supabase Storage
    const webpBuffer = fs.readFileSync(outputPath);
    const storagePath = `thumbnails/${baseName}.webp`;

    const { error: uploadError } = await supabase.storage
      .from('worksheets')
      .upload(storagePath, webpBuffer, {
        contentType: 'image/webp',
        cacheControl: '3600',
        upsert: false
      });

    if (uploadError) throw new Error('Supabase upload error: ' + uploadError.message);

    const { data: urlData } = supabase.storage
      .from('worksheets')
      .getPublicUrl(storagePath);

    // Limpiar archivos temporales
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    res.json({ thumbnailUrl: urlData.publicUrl });

  } catch (err) {
    // Limpiar en caso de error
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

app.listen(PORT, () => console.log(`Workshido Thumbnail Service running on port ${PORT}`));
