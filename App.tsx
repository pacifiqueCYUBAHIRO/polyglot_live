
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Type, FunctionDeclaration } from '@google/genai';
import { TranscriptionEntry, FeedbackItem, AppStatus, LearningMode, Exercise, UserStats, LANGUAGES, Language, ExerciseRecord, PronunciationDrill } from './types';
import { decode, encode, decodeAudioData, createPcmBlob } from './utils/audioUtils';
import VoiceWaveform from './components/VoiceWaveform';

const STORAGE_KEYS = {
  TRANSCRIPTIONS: 'polyglot_transcriptions',
  FEEDBACK: 'polyglot_feedback',
  STATS: 'polyglot_stats',
  EXERCISE_HISTORY: 'polyglot_exercise_history',
};

const SYSTEM_INSTRUCTION_BASE = `
You are Lingo, a friendly and expert bilingual language tutor specializing in English and French. 
Your primary mission is to help the user improve their speaking skills through context-rich, interactive learning.

CORE MODES:
1. CONVERSATION MODE: 
   - Act as a natural chat partner or a specialized character.
   - ROLE-PLAYING: Proactively offer and initiate role-playing scenarios based on everyday situations. 
2. PRONUNCIATION MODE: 
   - THIS IS A DEDICATED DRILLING MODE.
   - Focus on specific phonemes (e.g., French 'u' vs 'ou', English 'th' /θ/ or /ð/).
   - You MUST use 'setPronunciationDrill' to focus on a specific word or sound.
   - You MUST use 'provideDetailedPronunciationFeedback' to give mechanical tips.
   - Focus on mechanical instruction: tongue placement, lip rounding, breath control.
3. EXERCISE MODE: 
   - Structured learning. Use 'setExercise' to present challenges.
   - Use 'completeExercise' to log progress on success.

GENERAL RULES:
- Use 'provideFeedback' for grammar/vocab.
- Use 'provideDetailedPronunciationFeedback' for phonetic errors.
- Adjust complexity to user level.
`;

const provideFeedbackDeclaration: FunctionDeclaration = {
  name: 'provideFeedback',
  description: 'Provide specific feedback on grammar or vocabulary usage.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      category: { type: Type.STRING, enum: ['grammar', 'vocabulary'] },
      issue: { type: Type.STRING },
      correction: { type: Type.STRING },
      explanation: { type: Type.STRING },
    },
    required: ['category', 'issue', 'correction', 'explanation'],
  },
};

const provideDetailedPronunciationFeedbackDeclaration: FunctionDeclaration = {
  name: 'provideDetailedPronunciationFeedback',
  description: 'Provide deep phonetic feedback including IPA and mechanical instructions.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      issue: { type: Type.STRING, description: 'The word or sound the user mispronounced.' },
      correction: { type: Type.STRING, description: 'The correct pronunciation or phonetic tip.' },
      explanation: { type: Type.STRING, description: 'General feedback.' },
      ipa: { type: Type.STRING, description: 'IPA transcription (e.g. /θɪŋk/).' },
      mouthPosition: { type: Type.STRING, description: 'Mechanical tips (e.g. Place tongue between teeth).' },
      accuracyScore: { type: Type.NUMBER, description: 'Optional estimated accuracy 0-100.' }
    },
    required: ['issue', 'correction', 'explanation', 'ipa', 'mouthPosition'],
  },
};

const setPronunciationDrillDeclaration: FunctionDeclaration = {
  name: 'setPronunciationDrill',
  description: 'Set a specific word or phoneme to drill in Pronunciation Mode.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      word: { type: Type.STRING },
      phoneme: { type: Type.STRING },
      ipa: { type: Type.STRING },
      instruction: { type: Type.STRING },
    },
    required: ['word', 'phoneme', 'ipa', 'instruction'],
  },
};

const setExerciseDeclaration: FunctionDeclaration = {
  name: 'setExercise',
  description: 'Set a structured exercise for the user to complete.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING, enum: ['grammar', 'vocabulary', 'pronunciation'] },
      task: { type: Type.STRING },
      instruction: { type: Type.STRING },
    },
    required: ['type', 'task', 'instruction'],
  },
};

const completeExerciseDeclaration: FunctionDeclaration = {
  name: 'completeExercise',
  description: 'Mark the current exercise as successfully completed.',
  parameters: {
    type: Type.OBJECT,
    properties: { notes: { type: Type.STRING } },
  },
};

const App: React.FC = () => {
  const [status, setStatus] = useState<AppStatus>('idle');
  const [learningMode, setLearningMode] = useState<LearningMode>('conversation');
  const [targetLanguage, setTargetLanguage] = useState<Language>(LANGUAGES[0]);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [exerciseHistory, setExerciseHistory] = useState<ExerciseRecord[]>([]);
  const [stats, setStats] = useState<UserStats>({ turns: 0, exercisesCompleted: 0 });
  const [activeExercise, setActiveExercise] = useState<Exercise | null>(null);
  const [activeDrill, setActiveDrill] = useState<PronunciationDrill | null>(null);
  const [rightSidebarTab, setRightSidebarTab] = useState<'insights' | 'exercises' | 'library'>('insights');
  const [error, setError] = useState<string | null>(null);
  const [showRightSidebar, setShowRightSidebar] = useState(true);
  const [requestingExampleId, setRequestingExampleId] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const activeSessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const feedbackScrollRef = useRef<HTMLDivElement>(null);

  const currentInputRef = useRef('');
  const currentOutputRef = useRef('');

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => { setIsOnline(false); handleDisconnect(); };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); };
  }, []);

  useEffect(() => {
    const savedTranscriptions = localStorage.getItem(STORAGE_KEYS.TRANSCRIPTIONS);
    const savedFeedback = localStorage.getItem(STORAGE_KEYS.FEEDBACK);
    const savedStats = localStorage.getItem(STORAGE_KEYS.STATS);
    const savedHistory = localStorage.getItem(STORAGE_KEYS.EXERCISE_HISTORY);
    
    if (savedTranscriptions) try { setTranscriptions(JSON.parse(savedTranscriptions)); } catch (e) {}
    if (savedFeedback) try { setFeedback(JSON.parse(savedFeedback)); } catch (e) {}
    if (savedStats) try { setStats(JSON.parse(savedStats)); } catch (e) {}
    if (savedHistory) try { setExerciseHistory(JSON.parse(savedHistory)); } catch (e) {}
  }, []);

  useEffect(() => { localStorage.setItem(STORAGE_KEYS.TRANSCRIPTIONS, JSON.stringify(transcriptions)); }, [transcriptions]);
  useEffect(() => { localStorage.setItem(STORAGE_KEYS.FEEDBACK, JSON.stringify(feedback)); }, [feedback]);
  useEffect(() => { localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify(stats)); }, [stats]);
  useEffect(() => { localStorage.setItem(STORAGE_KEYS.EXERCISE_HISTORY, JSON.stringify(exerciseHistory)); }, [exerciseHistory]);

  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [transcriptions]);
  useEffect(() => { if (feedbackScrollRef.current) feedbackScrollRef.current.scrollTop = feedbackScrollRef.current.scrollHeight; }, [feedback, activeExercise, activeDrill]);

  const stopAllAudio = useCallback(() => {
    sourcesRef.current.forEach(source => { try { source.stop(); } catch (e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, []);

  const handleDisconnect = useCallback(() => {
    if (activeSessionRef.current) { activeSessionRef.current.close(); activeSessionRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(track => track.stop()); streamRef.current = null; }
    if (inputAudioContextRef.current) { inputAudioContextRef.current.close(); inputAudioContextRef.current = null; }
    stopAllAudio();
    setStatus('idle');
    setRequestingExampleId(null);
  }, [stopAllAudio]);

  const handleClearHistory = () => {
    if (window.confirm("Reset all progress and clear library history?")) {
      setTranscriptions([]);
      setFeedback([]);
      setExerciseHistory([]);
      setStats({ turns: 0, exercisesCompleted: 0 });
      setActiveExercise(null);
      setActiveDrill(null);
      localStorage.clear();
    }
  };

  const handleConnect = async () => {
    if (!isOnline) return;
    try {
      setStatus('connecting');
      setError(null);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const outputNode = outputAudioContextRef.current.createGain();
      outputNode.connect(outputAudioContextRef.current.destination);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          tools: [{ 
            functionDeclarations: [
              provideFeedbackDeclaration, 
              provideDetailedPronunciationFeedbackDeclaration,
              setPronunciationDrillDeclaration,
              setExerciseDeclaration, 
              completeExerciseDeclaration
            ] 
          }],
          systemInstruction: SYSTEM_INSTRUCTION_BASE + 
            `\nCURRENT MODE: ${learningMode.toUpperCase()} MODE.` +
            `\nTARGET LANGUAGE: ${targetLanguage.name}.`,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus('active');
            if (!inputAudioContextRef.current) return;
            const source = inputAudioContextRef.current.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'provideFeedback') {
                  const args = fc.args as any;
                  setFeedback(prev => [{
                    id: Math.random().toString(36).substr(2, 9),
                    category: args.category,
                    issue: args.issue,
                    correction: args.correction,
                    explanation: args.explanation,
                    timestamp: Date.now()
                  }, ...prev]);
                } else if (fc.name === 'provideDetailedPronunciationFeedback') {
                   const args = fc.args as any;
                   setFeedback(prev => [{
                     id: Math.random().toString(36).substr(2, 9),
                     category: 'pronunciation',
                     issue: args.issue,
                     correction: args.correction,
                     explanation: args.explanation,
                     ipa: args.ipa,
                     mouthPosition: args.mouthPosition,
                     accuracyScore: args.accuracyScore,
                     timestamp: Date.now()
                   }, ...prev]);
                } else if (fc.name === 'setPronunciationDrill') {
                  const args = fc.args as any;
                  setActiveDrill({
                    word: args.word,
                    phoneme: args.phoneme,
                    ipa: args.ipa,
                    instruction: args.instruction
                  });
                } else if (fc.name === 'setExercise') {
                  const args = fc.args as any;
                  setActiveExercise({
                    id: Math.random().toString(36).substr(2, 9),
                    type: args.type, task: args.task, instruction: args.instruction
                  });
                  setRightSidebarTab('exercises');
                } else if (fc.name === 'completeExercise') {
                  if (activeExercise) {
                    setExerciseHistory(prev => [{
                      ...activeExercise,
                      completedAt: Date.now(),
                      language: targetLanguage.name
                    }, ...prev]);
                  }
                  setStats(prev => ({ ...prev, exercisesCompleted: prev.exercisesCompleted + 1 }));
                  setActiveExercise(null);
                }
                sessionPromise.then(session => session.sendToolResponse({
                  functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } }
                }));
              }
            }

            if (message.serverContent?.outputTranscription) currentOutputRef.current += message.serverContent.outputTranscription.text;
            else if (message.serverContent?.inputTranscription) currentInputRef.current += message.serverContent.inputTranscription.text;

            if (message.serverContent?.turnComplete) {
              const uText = currentInputRef.current;
              const mText = currentOutputRef.current;
              if (uText || mText) {
                setTranscriptions(prev => [
                  ...prev,
                  ...(uText ? [{ role: 'user' as const, text: uText, timestamp: Date.now() }] : []),
                  ...(mText ? [{ role: 'model' as const, text: mText, timestamp: Date.now() }] : [])
                ]);
                if (uText && mText) setStats(prev => ({ ...prev, turns: prev.turns + 1 }));
              }
              currentInputRef.current = ''; currentOutputRef.current = ''; setRequestingExampleId(null);
            }

            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer; source.connect(outputNode);
              source.addEventListener('ended', () => sourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }
            if (message.serverContent?.interrupted) { stopAllAudio(); setRequestingExampleId(null); }
          },
          onerror: () => { setError('Session error. Disconnecting...'); handleDisconnect(); },
          onclose: () => handleDisconnect()
        }
      });
      activeSessionRef.current = await sessionPromise;
    } catch (err: any) {
      setError(err.message || 'Error connecting to the AI.');
      setStatus('idle');
    }
  };

  const handleRequestExample = useCallback((item: FeedbackItem) => {
    if (!isOnline) return alert("AI Examples require an internet connection.");
    if (!activeSessionRef.current || status !== 'active') return alert("Please start a session to request an example.");
    setRequestingExampleId(item.id);
    activeSessionRef.current.sendRealtimeInput({
      text: `Provide a natural example sentence in ${targetLanguage.name} using "${item.correction}"?`
    });
  }, [status, targetLanguage, isOnline]);

  const handleRequestScenario = useCallback(() => {
    if (!activeSessionRef.current || status !== 'active') return;
    activeSessionRef.current.sendRealtimeInput({
      text: `Suggest a new role-playing scenario in ${targetLanguage.name} for us to practice. Pick an interesting everyday situation like ordering food, a travel mishap, or a social gathering.`
    });
  }, [status, targetLanguage]);

  const getCategoryColor = (cat: string) => {
    switch (cat) {
      case 'pronunciation': return 'bg-purple-100 text-purple-700 border-purple-200';
      case 'grammar': return 'bg-blue-100 text-blue-700 border-blue-200';
      case 'vocabulary': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
      default: return 'bg-slate-100 text-slate-700 border-slate-200';
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center p-4 md:p-8">
      <header className="w-full max-w-6xl flex flex-col md:flex-row justify-between items-center gap-6 mb-8">
        <div className="flex items-center gap-3">
          <div className={`${learningMode === 'pronunciation' ? 'bg-purple-600' : learningMode === 'exercise' ? 'bg-emerald-600' : 'bg-indigo-600'} p-2 rounded-xl shadow-lg transition-colors`}>
            <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-slate-800 leading-none">Polyglot Live</h1>
              <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full border ${isOnline ? 'bg-green-100 text-green-700 border-green-200' : 'bg-rose-100 text-rose-700 border-rose-200'}`}>
                {isOnline ? '● Online' : '● Offline'}
              </span>
            </div>
            <div className="flex items-center gap-4 mt-1.5">
               <div className="flex items-center gap-1.5 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100 shadow-sm">
                  <span className="text-[10px] font-black text-indigo-400 uppercase tracking-tighter">Turns</span>
                  <span className="text-xs font-bold text-indigo-700">{stats.turns}</span>
               </div>
               <div className="flex items-center gap-1.5 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100 shadow-sm">
                  <span className="text-[10px] font-black text-emerald-400 uppercase tracking-tighter">Exercises</span>
                  <span className="text-xs font-bold text-emerald-700">{stats.exercisesCompleted}</span>
               </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap justify-center items-center gap-4">
          <div className="flex bg-slate-200/50 p-1 rounded-xl border border-slate-200">
            {['conversation', 'pronunciation', 'exercise'].map(m => (
              <button key={m} onClick={() => setLearningMode(m as LearningMode)} disabled={status !== 'idle'}
                className={`px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-tight transition-all ${learningMode === m ? `bg-white text-indigo-600 shadow-sm` : 'text-slate-500 hover:text-slate-700'}`}
              >
                {m}
              </button>
            ))}
          </div>

          <div className="flex bg-white p-1 rounded-lg shadow-sm border border-slate-200">
            {LANGUAGES.map((lang) => (
              <button key={lang.code} onClick={() => setTargetLanguage(lang)} disabled={status !== 'idle'}
                className={`px-4 py-2 rounded-md transition-all flex items-center gap-2 ${targetLanguage.code === lang.code ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-600 hover:bg-slate-50'} disabled:opacity-50 font-semibold`}
              >
                <span>{lang.flag}</span>
                <span className="hidden sm:inline">{lang.name}</span>
              </button>
            ))}
          </div>

          <button onClick={handleClearHistory} className="p-2.5 rounded-lg bg-white border border-slate-200 text-slate-400 hover:text-rose-500 transition-colors" title="Reset All Progress">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
          </button>
        </div>
      </header>

      <main className="w-full max-w-6xl flex-grow grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className={`lg:col-span-2 bg-white rounded-3xl shadow-xl border border-slate-100 flex flex-col overflow-hidden`}>
          <div className={`p-4 border-b border-slate-100 flex justify-between items-center ${learningMode === 'pronunciation' ? 'bg-purple-50/50' : learningMode === 'exercise' ? 'bg-emerald-50/50' : 'bg-indigo-50/50'}`}>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${status === 'active' ? 'bg-green-500 animate-pulse' : 'bg-slate-300'}`} />
              <span className="text-sm font-bold text-slate-500 uppercase tracking-tight">
                {learningMode === 'pronunciation' ? 'Phonetic Drilling Studio' : status === 'active' ? 'Live Session Active' : 'Polyglot Library'}
              </span>
            </div>
            <div className="flex gap-2">
              {learningMode === 'conversation' && status === 'active' && (
                <button 
                  onClick={handleRequestScenario}
                  className="px-3 py-1 rounded-full text-[10px] font-black uppercase transition-all bg-indigo-100 text-indigo-700 hover:bg-indigo-200 flex items-center gap-1.5"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  Suggest Scenario
                </button>
              )}
              <button onClick={() => setShowRightSidebar(!showRightSidebar)} className={`px-3 py-1 rounded-full text-[10px] font-black uppercase transition-colors ${showRightSidebar ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-500'}`}>
                Sidebar {showRightSidebar ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
          
          <div ref={scrollRef} className="flex-grow overflow-y-auto p-6 space-y-4 min-h-[400px]">
            {learningMode === 'pronunciation' && activeDrill && (
              <div className="mb-6 bg-purple-50 border border-purple-100 rounded-2xl p-6 shadow-sm animate-in fade-in slide-in-from-top-4 duration-500">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <span className="text-[10px] font-black uppercase text-purple-400 tracking-widest block mb-1">Target Word & IPA</span>
                    <h2 className="text-4xl font-black text-purple-900 leading-none">{activeDrill.word}</h2>
                    <p className="text-xl font-medium text-purple-600 mt-1">{activeDrill.ipa}</p>
                  </div>
                  <div className="bg-white p-3 rounded-xl border border-purple-100 shadow-sm flex-1 max-w-md">
                     <p className="text-[10px] font-black uppercase text-slate-400 mb-1">Drill Instructions</p>
                     <p className="text-xs font-semibold text-slate-700 leading-relaxed">{activeDrill.instruction}</p>
                  </div>
                </div>
              </div>
            )}

            {transcriptions.length === 0 && !activeExercise && !activeDrill && (
              <div className="h-full flex flex-col items-center justify-center text-center p-8 opacity-40">
                <div className={`w-20 h-20 bg-slate-50 text-slate-400 rounded-full flex items-center justify-center mb-4`}>
                   <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg>
                </div>
                <h3 className="text-lg font-bold text-slate-700">Polyglot Studio</h3>
                <p className="text-sm max-w-xs">{isOnline ? 'Choose a mode and start your session.' : 'You are offline. Review history in the sidebar.'}</p>
              </div>
            )}
            {transcriptions.map((entry, idx) => (
              <div key={idx} className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] p-4 rounded-2xl shadow-sm ${entry.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-none shadow-indigo-100' : 'bg-slate-100 text-slate-800 rounded-tl-none border border-slate-200'}`}>
                  <p className="text-sm md:text-base leading-relaxed">{entry.text}</p>
                </div>
              </div>
            ))}
          </div>

          <div className={`p-8 border-t border-slate-100 flex flex-col items-center gap-4 ${learningMode === 'pronunciation' ? 'bg-purple-50/30' : learningMode === 'exercise' ? 'bg-emerald-50/30' : 'bg-slate-50/50'}`}>
            <VoiceWaveform isActive={status === 'active'} color={learningMode === 'pronunciation' ? '#9333ea' : learningMode === 'exercise' ? '#059669' : '#4f46e5'} />
            <div className="flex items-center gap-6">
              {status === 'active' || status === 'connecting' ? (
                <button onClick={handleDisconnect} className="bg-rose-500 hover:bg-rose-600 text-white p-5 rounded-full shadow-lg transition-all hover:scale-105 active:scale-95 group relative">
                  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              ) : (
                <button onClick={handleConnect} disabled={!isOnline} className={`${!isOnline ? 'bg-slate-300' : learningMode === 'pronunciation' ? 'bg-purple-600 shadow-purple-200' : learningMode === 'exercise' ? 'bg-emerald-600 shadow-emerald-200' : 'bg-indigo-600 shadow-indigo-200'} text-white p-6 rounded-full shadow-xl transition-all hover:scale-105 active:scale-95 group relative`}>
                  <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                  <span className="absolute -bottom-10 left-1/2 -translate-x-1/2 text-[10px] font-black text-slate-600 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap uppercase tracking-widest">
                    {isOnline ? `Start ${learningMode}` : 'Offline Mode'}
                  </span>
                </button>
              )}
            </div>
            {error && <div className="mt-2 text-rose-500 text-xs font-bold text-center animate-pulse">{error}</div>}
          </div>
        </div>

        {showRightSidebar && (
          <div className="bg-white rounded-3xl shadow-xl border border-slate-100 flex flex-col overflow-hidden max-h-[80vh] lg:max-h-full transition-all">
            <div className="flex border-b border-slate-100 overflow-x-auto">
              {['insights', 'exercises', 'library'].map(tab => (
                <button key={tab} onClick={() => setRightSidebarTab(tab as any)}
                  className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest transition-all ${rightSidebarTab === tab ? `bg-white text-indigo-600 border-b-2 border-indigo-600` : 'bg-slate-50 text-slate-400 hover:bg-slate-100'}`}
                >
                  {tab === 'library' ? 'History' : tab}
                </button>
              ))}
            </div>
            
            <div ref={feedbackScrollRef} className="flex-grow overflow-y-auto p-4 space-y-4 bg-slate-50/10">
              {rightSidebarTab === 'insights' && (
                feedback.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center opacity-30 py-12">
                    <p className="text-xs font-bold uppercase tracking-widest text-slate-400">No Insights Yet</p>
                  </div>
                ) : (
                  feedback.map((item) => (
                    <div key={item.id} className="bg-white border border-slate-100 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow ring-1 ring-slate-100/50">
                      <div className="flex justify-between items-start mb-3">
                        <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded border ${getCategoryColor(item.category)}`}>{item.category}</span>
                        <span className="text-[9px] text-slate-400 font-medium">{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <div className="space-y-3">
                        {item.category === 'pronunciation' ? (
                          <>
                            <div className="flex items-center justify-between">
                              <h4 className="text-lg font-black text-slate-800">{item.issue}</h4>
                              {item.accuracyScore !== undefined && (
                                <span className={`text-xs font-black px-2 py-0.5 rounded-full ${item.accuracyScore > 80 ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                                  {item.accuracyScore}% Accuracy
                                </span>
                              )}
                            </div>
                            <div className="flex flex-col gap-1">
                              <p className="text-[9px] text-slate-400 font-black uppercase tracking-tighter">Phonetics (IPA)</p>
                              <p className="text-purple-600 font-bold text-lg">{item.ipa}</p>
                            </div>
                            <div className="bg-purple-50 p-2.5 rounded-xl border border-purple-100">
                               <p className="text-[9px] text-purple-400 font-black uppercase mb-1 tracking-tighter">Mechanical Instruction</p>
                               <p className="text-xs font-medium text-purple-900 italic leading-relaxed">{item.mouthPosition}</p>
                            </div>
                          </>
                        ) : (
                          <>
                            <div><p className="text-[9px] text-slate-400 font-black uppercase mb-1 tracking-tighter">Issue</p><p className="text-rose-500 font-medium text-sm line-through">"{item.issue}"</p></div>
                            <div><p className="text-[9px] text-slate-400 font-black uppercase mb-1 tracking-tighter">Correction</p>
                              <p className={`font-bold px-2 py-1.5 rounded text-sm bg-indigo-50 text-indigo-700 flex justify-between items-center`}>
                                <span>{item.correction}</span>
                                <button onClick={() => handleRequestExample(item)} disabled={!isOnline || status !== 'active' || requestingExampleId === item.id}
                                  className={`text-[9px] font-black uppercase px-2 py-1 rounded transition-all ${requestingExampleId === item.id ? 'bg-amber-100 text-amber-600 animate-pulse' : 'bg-indigo-600 text-white disabled:opacity-30'}`}
                                >
                                  {requestingExampleId === item.id ? 'Thinking...' : '💡 Example'}
                                </button>
                              </p>
                            </div>
                          </>
                        )}
                        <div className="bg-slate-50 p-2 rounded text-xs text-slate-600 leading-relaxed italic">{item.explanation}</div>
                      </div>
                    </div>
                  ))
                )
              )}

              {rightSidebarTab === 'exercises' && (
                <div className="space-y-4">
                  {activeExercise ? (
                    <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-6 shadow-sm">
                      <h4 className="font-black text-[10px] uppercase tracking-widest text-emerald-800 mb-4">Active Task</h4>
                      <div className="bg-white p-5 rounded-xl border border-emerald-100 mb-4 text-center"><p className="text-lg font-medium text-slate-800">{activeExercise.task}</p></div>
                      <p className="text-[9px] font-black uppercase text-emerald-600 mb-1">Instruction</p><p className="text-xs font-semibold text-emerald-900">{activeExercise.instruction}</p>
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-center opacity-30 py-12">
                      <p className="text-xs font-bold uppercase tracking-widest text-slate-400">No Active Task</p>
                    </div>
                  )}
                </div>
              )}

              {rightSidebarTab === 'library' && (
                <div className="space-y-4">
                  {exerciseHistory.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center opacity-30 py-12">
                       <p className="text-xs font-bold uppercase tracking-widest text-slate-400">No History Found</p>
                    </div>
                  ) : (
                    exerciseHistory.map((ex, idx) => (
                      <div key={idx} className="bg-white border border-slate-100 rounded-xl p-4 shadow-sm">
                        <div className="flex justify-between items-center mb-2">
                           <span className="text-[9px] font-black uppercase text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">{ex.type}</span>
                           <span className="text-[8px] text-slate-400 font-bold">{new Date(ex.completedAt).toLocaleDateString()}</span>
                        </div>
                        <p className="text-xs font-bold text-slate-800 mb-1 italic">"{ex.task}"</p>
                        <p className="text-[10px] text-slate-500 leading-tight">{ex.instruction}</p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      <footer className="w-full max-w-6xl mt-8 flex flex-col md:flex-row justify-between items-center text-slate-400 text-[10px] font-bold uppercase tracking-widest gap-4 px-2">
        <p>© 2024 Polyglot Live AI • Pronunciation Studio Enabled</p>
        <div className="flex gap-6">
          <span className="flex items-center gap-2"><span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-green-500' : 'bg-rose-500'}`}></span>{isOnline ? 'Immersive Live' : 'Offline Library'}</span>
          <span className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>Cloud Sync</span>
        </div>
      </footer>
    </div>
  );
};

export default App;
