import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.local if present and GEMINI_API_KEY is not already injected
if (!process.env.GEMINI_API_KEY && fs.existsSync(path.resolve(__dirname, '.env.local'))) {
  try {
    process.loadEnvFile(path.resolve(__dirname, '.env.local'));
  } catch {
    // Ignore if environment file cannot be loaded
  }
}

const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function getAiClient(apiVersion?: string): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey,
    ...(apiVersion ? { apiVersion } : {}),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getErrorStatus(error: unknown): number {
  if (typeof error === 'object' && error !== null) {
    const err = error as { status?: number; code?: number; statusCode?: number };
    const status = err.status ?? err.code ?? err.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 600) {
      return status;
    }
  }
  return 500;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    const raw = error.message.trim();
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
        const inner = parsed?.error?.message || parsed?.message;
        if (inner) return inner;
      } catch {
        // Fall through to raw message
      }
    }
    return raw;
  }
  return fallback;
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = getErrorStatus(error);
      const isRetryable = status === 429 || status >= 500;
      if (!isRetryable || attempt === maxAttempts - 1) {
        throw error;
      }
      const delayMs = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function ensureWavBuffer(audioBuffer: Buffer, sampleRate = 24000): Buffer {
  // Check if buffer already contains a RIFF/WAVE header
  if (
    audioBuffer.length >= 12 &&
    audioBuffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    audioBuffer.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return audioBuffer;
  }

  // Otherwise prepend a standard 44-byte PCM WAV header (mono, 16-bit LE)
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + audioBuffer.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(audioBuffer.length, 40);

  return Buffer.concat([header, audioBuffer]);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // Scan shloka from image
  app.post('/api/scan', async (req, res) => {
    try {
      const { imageBase64, mimeType } = req.body as {
        imageBase64?: string;
        mimeType?: string;
      };

      if (!imageBase64 || typeof imageBase64 !== 'string') {
        res.status(400).json({ error: 'प्रतिमा डेटा आवश्यक आहे.' });
        return;
      }

      const ai = getAiClient();
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: mimeType || 'image/jpeg',
                  data: imageBase64,
                },
              },
              {
                text: 'या प्रतिमेतून फक्त संस्कृत किंवा मराठी श्लोक किंवा मंत्राचे शब्द ओळखा आणि ते मजकूर स्वरूपात द्या. अतिरिक्त काहीही लिहू नका.',
              },
            ],
          },
        })
      );

      const text = (response.text ?? '').trim();
      res.json({ text });
    } catch (error) {
      console.error('Error in /api/scan:', error);
      const status = getErrorStatus(error);
      res.status(status).json({
        error: getErrorMessage(error, 'स्कॅनिंग करताना त्रुटी आली.'),
      });
    }
  });

  // Transcribe spoken shloka audio to Devanagari text
  app.post('/api/transcribe', async (req, res) => {
    try {
      const { audioBase64, mimeType } = req.body as {
        audioBase64?: string;
        mimeType?: string;
      };

      if (!audioBase64 || typeof audioBase64 !== 'string') {
        res.status(400).json({ error: 'ऑडिओ डेटा आवश्यक आहे.' });
        return;
      }

      const cleanMimeType = (mimeType || 'audio/webm').split(';')[0].trim() || 'audio/webm';
      const ai = getAiClient();
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: cleanMimeType,
                  data: audioBase64,
                },
              },
              {
                text: 'Listen carefully to this audio and transcribe the spoken Sanskrit or Marathi shloka or words accurately in Devanagari script. Output only the spoken Devanagari text, nothing else.',
              },
            ],
          },
          config: {
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.LOW,
            },
          },
        })
      );

      const text = (response.text ?? '').trim();
      res.json({ text });
    } catch (error) {
      console.error('Error in /api/transcribe:', error);
      const status = getErrorStatus(error);
      res.status(status).json({
        error: getErrorMessage(error, 'आवाज ओळखताना त्रुटी आली.'),
      });
    }
  });

  // Explain Mahabharata / Bhagavad Gita shloka in Marathi
  app.post('/api/explain', async (req, res) => {
    try {
      const { shloka } = req.body as { shloka?: string };
      if (!shloka || typeof shloka !== 'string' || !shloka.trim()) {
        res.status(400).json({ error: 'कृपया श्लोक लिहा किंवा बोला.' });
        return;
      }

      const ai = getAiClient();
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `मी तुम्हाला एक भगवद्गीता किंवा महाभारताचा श्लोक देणार आहे: "${shloka.trim()}". कृपया खालील माहिती मराठीत द्या: 1. मूळ संस्कृत श्लोक. 2. श्लोकाचा नेमका मराठी अनुवाद. 3. श्लोकाचा सविस्तर अर्थ (मराठीत). 4. आजच्या काळात लागू होणारे एक उत्तम उदाहरण (मराठीत). माहिती JSON स्वरूपात द्या: { "original": "", "translation": "", "explanation": "", "example": "" }`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                original: { type: Type.STRING },
                translation: { type: Type.STRING },
                explanation: { type: Type.STRING },
                example: { type: Type.STRING },
              },
              required: ['original', 'translation', 'explanation', 'example'],
            },
          },
        })
      );

      const rawText = (response.text ?? '{}').trim();
      const cleanJson = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
      const parsed = JSON.parse(cleanJson) as {
        original: string;
        translation: string;
        explanation: string;
        example: string;
      };

      res.json(parsed);
    } catch (error) {
      console.error('Error in /api/explain:', error);
      const status = getErrorStatus(error);
      res.status(status).json({
        error: getErrorMessage(error, 'माहिती मिळवताना त्रुटी आली.'),
      });
    }
  });

  // Generate Marathi voiceover audio (WAV)
  app.post('/api/tts', async (req, res) => {
    try {
      const { original, translation, explanation, example } = req.body as {
        original?: string;
        translation?: string;
        explanation?: string;
        example?: string;
      };

      if (!original && !explanation) {
        res.status(400).json({ error: 'ऑडिओसाठी मजकूर आवश्यक आहे.' });
        return;
      }

      const textToSpeak = `जय श्रीकृष्ण. श्लोक: ${original ?? ''}. अनुवाद: ${translation ?? ''}. अर्थ: ${explanation ?? ''}. उदाहरण: ${example ?? ''}`;

      const ai = getAiClient('v1beta');
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: 'gemini-3.8-flash-lite-tts',
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: textToSpeak,
                  speechMetadata: {
                    style: 'Calm, clear, devotional Marathi narrator explaining a Mahabharata shloka',
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Kore' },
              },
            },
          },
        })
      );

      const base64Audio =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!base64Audio) {
        res.status(502).json({ error: 'ऑडिओ तयार करता आला नाही.' });
        return;
      }

      const rawBuffer = Buffer.from(base64Audio, 'base64');
      const wavBuffer = ensureWavBuffer(rawBuffer, 24000);

      res.json({
        audio: wavBuffer.toString('base64'),
        mimeType: 'audio/wav',
      });
    } catch (error) {
      console.error('Error in /api/tts:', error);
      const status = getErrorStatus(error);
      res.status(status).json({
        error: getErrorMessage(error, 'ऑडिओ तयार करताना त्रुटी आली.'),
      });
    }
  });

  if (!IS_PRODUCTION) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Shlok Bhashantar server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
