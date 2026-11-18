import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

interface ShlokaResult {
  original: string;
  translation: string;
  explanation: string;
  example: string;
}

// --- Utility Functions ---

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

const formatTime = (seconds: number) => {
  if (isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const ShlokLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 100 100" className={className} xmlns="http://www.w3.org/2000/svg">
    <circle cx="50" cy="50" r="48" fill="white" fillOpacity="0.2" />
    <path d="M50 20 C60 40 80 45 80 65 C80 80 65 90 50 90 C35 90 20 80 20 65 C20 45 40 40 50 20Z" fill="#ffffff" />
    <circle cx="50" cy="65" r="10" fill="#ea580c" />
    <path d="M50 35 L50 55" stroke="#ea580c" strokeWidth="4" strokeLinecap="round" />
  </svg>
);

const App = () => {
  const [shlokaInput, setShlokaInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [scanLoading, setScanLoading] = useState(false);
  const [transcribeLoading, setTranscribeLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [result, setResult] = useState<ShlokaResult | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Clean up object URL on change/unmount
  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  // Clean up mic stream on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // Auto-play when audioUrl is set
  useEffect(() => {
    if (audioUrl && audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
      audioRef.current.play().catch((err) => console.error('Playback failed:', err));
    }
  }, [audioUrl]);

  const transcribeAudioBlob = async (blob: Blob, mimeType: string) => {
    setTranscribeLoading(true);
    try {
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const resultStr = reader.result as string;
          const base64 = resultStr.split(',')[1] || '';
          resolve(base64);
        };
        reader.onerror = () => reject(new Error('ऑडिओ वाचताना त्रुटी आली.'));
        reader.readAsDataURL(blob);
      });

      if (!base64Data) {
        throw new Error('आवाज रेकॉर्ड होऊ शकला नाही. कृपया पुन्हा प्रयत्न करा.');
      }

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: base64Data, mimeType }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'आवाज ओळखताना त्रुटी आली.');
      }

      const transcribedText = (data.text || '').trim();
      if (transcribedText) {
        setShlokaInput(transcribedText);
      } else {
        setErrorMessage('आवाज स्पष्ट ऐकू आला नाही. कृपया पुन्हा बोला.');
      }
    } catch (error) {
      console.error('Transcription error:', error);
      setErrorMessage(
        error instanceof Error ? error.message : 'आवाज ओळखताना त्रुटी आली.'
      );
    } finally {
      setTranscribeLoading(false);
    }
  };

  const toggleVoiceRecording = async () => {
    setErrorMessage(null);

    if (isListening && mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      setIsListening(false);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setErrorMessage('तुमचा ब्राउझर किंवा डिव्हाइस माइक रेकॉर्डिंगला सपोर्ट करत नाही.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const preferredTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      const supportedType = preferredTypes.find((type) =>
        MediaRecorder.isTypeSupported(type)
      );

      const recorder = supportedType
        ? new MediaRecorder(stream, { mimeType: supportedType })
        : new MediaRecorder(stream);

      audioChunksRef.current = [];
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        setIsListening(false);

        const mimeType = recorder.mimeType || supportedType || 'audio/webm';
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        audioChunksRef.current = [];

        if (audioBlob.size === 0) {
          setErrorMessage('आवाज रेकॉर्ड होऊ शकला नाही. कृपया पुन्हा प्रयत्न करा.');
          return;
        }

        await transcribeAudioBlob(audioBlob, mimeType);
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        setIsListening(false);
        setErrorMessage('मायक्रोफोन रेकॉर्डिंगमध्ये त्रुटी आली.');
      };

      recorder.start();
      setIsListening(true);
    } catch (error: any) {
      console.error('Microphone error:', error);
      setIsListening(false);
      if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
        setErrorMessage('मायक्रोफोन परवानगी नाकारली आहे. कृपया ब्राउझरमध्ये माइक परवानगी द्या.');
      } else if (error?.name === 'NotFoundError') {
        setErrorMessage('डिव्हाइसवर मायक्रोफोन सापडला नाही.');
      } else {
        setErrorMessage('मायक्रोफोन सुरू करता आला नाही. कृपया पुन्हा प्रयत्न करा.');
      }
    }
  };

  const handleScanClick = () => {
    fileInputRef.current?.click();
  };

  const handleImageCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMessage(null);
    setScanLoading(true);
    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64Data = (reader.result as string).split(',')[1];
      await processImage(base64Data, file.type);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const processImage = async (base64Data: string, mimeType: string) => {
    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64Data, mimeType }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'स्कॅनिंग करताना त्रुटी आली.');
      }

      const extractedText = (data.text || '').trim();
      if (extractedText) {
        setShlokaInput(extractedText);
        setTimeout(() => triggerExplanation(extractedText), 500);
      } else {
        setErrorMessage('प्रतिमेतून श्लोक वाचता आला नाही. कृपया स्पष्ट फोटो काढा.');
      }
    } catch (error) {
      console.error('Scanning error:', error);
      setErrorMessage(
        error instanceof Error ? error.message : 'स्कॅनिंग करताना त्रुटी आली.'
      );
    } finally {
      setScanLoading(false);
    }
  };

  const triggerExplanation = async (text: string) => {
    if (!text.trim()) return;
    setErrorMessage(null);
    setLoading(true);
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    setResult(null);
    setCurrentTime(0);
    setDuration(0);

    try {
      const response = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shloka: text }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'माहिती मिळवताना त्रुटी आली.');
      }

      setResult(data as ShlokaResult);
    } catch (error) {
      console.error('Explanation error:', error);
      setErrorMessage(
        error instanceof Error ? error.message : 'माहिती मिळवताना त्रुटी आली.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleExplain = () => triggerExplanation(shlokaInput);

  const generateAndPlayAudio = async () => {
    if (!result || audioLoading) return;

    if (audioUrl) {
      if (audioRef.current) {
        if (audioRef.current.paused) {
          audioRef.current.play();
        } else {
          audioRef.current.pause();
        }
      }
      return;
    }

    setErrorMessage(null);
    setAudioLoading(true);
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          original: result.original,
          translation: result.translation,
          explanation: result.explanation,
          example: result.example,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'ऑडिओ तयार करता आला नाही.');
      }

      if (data.audio) {
        const audioBytes = base64ToUint8Array(data.audio);
        const wavBlob = new Blob([audioBytes], {
          type: data.mimeType || 'audio/wav',
        });
        const url = URL.createObjectURL(wavBlob);
        setAudioUrl(url);
      } else {
        setErrorMessage('ऑडिओ तयार करता आला नाही.');
      }
    } catch (error) {
      console.error('Audio generation error:', error);
      setErrorMessage(
        error instanceof Error ? error.message : 'ऑडिओ त्रुटी.'
      );
    } finally {
      setAudioLoading(false);
    }
  };

  const downloadAudio = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!audioUrl) return;
    const link = document.createElement('a');
    link.href = audioUrl;
    link.download = `shlok-nirupan-${Date.now()}.wav`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (audioRef.current) audioRef.current.currentTime = time;
  };

  const changePlaybackRate = (e: React.MouseEvent, rate: number) => {
    e.stopPropagation();
    setPlaybackRate(rate);
    if (audioRef.current) audioRef.current.playbackRate = rate;
  };

  return (
    <div className="min-h-screen pb-10 bg-[#fcf8f1]">
      <header className="saffron-gradient text-white pt-10 pb-16 px-6 text-center shadow-lg relative overflow-hidden">
        <div className="flex justify-center mb-6">
          <ShlokLogo className="w-20 h-20 animate-pulse drop-shadow-2xl" />
        </div>
        <h1 className="serif text-4xl font-bold mb-2 text-white">श्लोक भाषांतर</h1>
        <p className="text-sm opacity-90 italic">प्राचीन ज्ञान, आधुनिक तंत्र</p>
      </header>

      <main className="max-w-xl mx-auto px-4 -mt-10 relative z-20">
        <section className="glass rounded-[2rem] p-6 shadow-xl mb-8">
          <div className="flex flex-col gap-4">
            <div className="relative">
              <textarea
                value={shlokaInput}
                onChange={(e) => setShlokaInput(e.target.value)}
                placeholder="श्लोक लिहा, बोला किंवा स्कॅन करा..."
                className="w-full bg-white border border-orange-50 rounded-2xl p-5 pr-12 text-lg devanagari min-h-[140px] outline-none shadow-sm transition-all focus:border-orange-300"
              />
              {(scanLoading || transcribeLoading) && (
                <div className="absolute inset-0 bg-white/60 flex items-center justify-center rounded-2xl">
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-8 h-8 border-4 border-orange-500 border-t-transparent rounded-full animate-spin"></div>
                    <span className="text-xs font-bold text-orange-600">
                      {scanLoading ? 'प्रतिमा वाचत आहे...' : 'आवाज ओळखत आहे...'}
                    </span>
                  </div>
                </div>
              )}
              {isListening && (
                <div className="absolute left-4 bottom-3 flex items-center gap-2 bg-red-50 border border-red-200 text-red-600 px-3 py-1 rounded-lg text-xs font-medium devanagari">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-ping"></span>
                  ऐकत आहे... बोलून झाल्यावर लाल माइक बटण पुन्हा दाबा
                </div>
              )}
              <div className="absolute right-3 top-3 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={toggleVoiceRecording}
                  disabled={transcribeLoading || scanLoading}
                  className={`p-2.5 rounded-full transition-all shadow-sm ${
                    isListening ? 'bg-red-500 text-white animate-pulse' : 'bg-orange-50 text-orange-600 hover:bg-orange-100'
                  } disabled:opacity-50`}
                  title={isListening ? 'थांबवा' : 'बोला'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" strokeWidth="2" />
                  </svg>
                </button>
                <button
                  onClick={handleScanClick}
                  className="p-2.5 rounded-full bg-orange-50 text-orange-600 transition-all shadow-sm hover:bg-orange-100"
                  title="स्कॅन करा"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
              </div>
            </div>

            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleImageCapture}
            />

            {errorMessage && (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm devanagari"
              >
                <span>{errorMessage}</span>
                <button
                  onClick={() => setErrorMessage(null)}
                  className="text-red-500 hover:text-red-700 font-bold text-xs shrink-0"
                  aria-label="बंद करा"
                >
                  ✕
                </button>
              </div>
            )}

            <button
              onClick={handleExplain}
              disabled={loading || scanLoading || transcribeLoading || isListening || !shlokaInput.trim()}
              className="w-full saffron-gradient text-white font-bold py-4 rounded-2xl text-xl shadow-lg disabled:opacity-50 active:scale-95 transition-all"
            >
              {loading ? (
                <div className="flex items-center justify-center gap-3">
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  निरूपण मिळवत आहे...
                </div>
              ) : (
                'निरूपण पहा'
              )}
            </button>
          </div>
        </section>

        {result && (
          <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
            <div className="bg-white rounded-[2rem] p-8 shadow-xl border-t-[12px] border-orange-500">
              <p className="devanagari text-2xl font-bold text-gray-800 text-center italic mb-8 whitespace-pre-line leading-relaxed">
                {result.original}
              </p>

              <div className="space-y-6">
                <div className="bg-orange-50/50 p-6 rounded-3xl border border-orange-100">
                  <div className="flex flex-col gap-4 mb-6">
                    <button
                      onClick={generateAndPlayAudio}
                      disabled={audioLoading}
                      className={`w-full py-4 rounded-2xl font-bold text-white shadow-lg transition-all active:scale-95 ${
                        isPlaying ? 'bg-red-500' : 'bg-orange-600'
                      }`}
                    >
                      {audioLoading ? (
                        <div className="flex items-center justify-center gap-2">
                          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                          ऑडिओ तयार होत आहे...
                        </div>
                      ) : isPlaying ? (
                        'थांबवा (Pause)'
                      ) : (
                        'मराठीत ऐका (Listen)'
                      )}
                    </button>

                    {audioUrl && (
                      <div className="bg-white p-4 rounded-xl shadow-inner border border-orange-100 space-y-4">
                        <input
                          type="range"
                          min="0"
                          max={duration || 0}
                          step="0.01"
                          value={currentTime}
                          onChange={handleSeek}
                          className="w-full accent-orange-600"
                        />
                        <div className="flex justify-between items-center text-[10px] font-mono text-orange-700">
                          <span className="bg-orange-50 px-2 py-0.5 rounded">{formatTime(currentTime)}</span>
                          <div className="flex gap-2 items-center">
                            {[0.5, 1, 1.5].map((r) => (
                              <button
                                key={r}
                                onClick={(e) => changePlaybackRate(e, r)}
                                className={`px-2 py-1 rounded-lg text-[10px] font-bold transition-all ${
                                  playbackRate === r
                                    ? 'bg-orange-500 text-white shadow-sm'
                                    : 'bg-orange-100 text-orange-600'
                                }`}
                              >
                                {r}x
                              </button>
                            ))}
                            <button
                              onClick={downloadAudio}
                              className="ml-2 p-1.5 rounded-full bg-green-100 text-green-700 hover:bg-green-200 transition-all shadow-sm"
                              title="डाउनलोड करा"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                              </svg>
                            </button>
                          </div>
                          <span className="bg-orange-50 px-2 py-0.5 rounded">{formatTime(duration)}</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <h3 className="text-sm font-bold text-orange-900 uppercase tracking-widest mb-2">विस्तृत अर्थ:</h3>
                  <p className="text-lg devanagari leading-relaxed text-gray-800">
                    {result.explanation}
                  </p>
                </div>

                <div className="p-6 bg-green-50 rounded-3xl border-l-8 border-green-500 shadow-sm">
                  <h3 className="text-xs font-bold text-green-700 uppercase mb-2">दैनंदिन उदाहरण:</h3>
                  <p className="text-lg italic devanagari text-gray-700 leading-relaxed">
                    "{result.example}"
                  </p>
                </div>
              </div>
            </div>

            <button
              onClick={() => {
                setShlokaInput('');
                setResult(null);
                setErrorMessage(null);
                if (audioUrl) URL.revokeObjectURL(audioUrl);
                setAudioUrl(null);
              }}
              className="w-full py-3 text-xs text-gray-400 hover:text-orange-600 font-medium transition-colors"
            >
              नवीन श्लोक शोधा
            </button>
          </div>
        )}
      </main>

      {/* Hidden Audio Element - Always present for stable ref */}
      <audio
        ref={audioRef}
        src={audioUrl || undefined}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime || 0)}
        onLoadedMetadata={() => {
          setDuration(audioRef.current?.duration || 0);
          if (audioRef.current) audioRef.current.playbackRate = playbackRate;
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      />
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
