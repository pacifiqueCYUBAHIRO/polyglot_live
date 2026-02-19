
export interface TranscriptionEntry {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export interface FeedbackItem {
  id: string;
  category: 'pronunciation' | 'grammar' | 'vocabulary';
  issue: string;
  correction: string;
  explanation: string;
  timestamp: number;
  // Optional phonetic fields
  ipa?: string;
  mouthPosition?: string;
  accuracyScore?: number;
}

export interface UserStats {
  turns: number;
  exercisesCompleted: number;
}

export type AppStatus = 'idle' | 'connecting' | 'active' | 'error';
export type LearningMode = 'conversation' | 'pronunciation' | 'exercise';

export interface Exercise {
  type: 'grammar' | 'vocabulary' | 'pronunciation';
  task: string;
  instruction: string;
  id: string;
}

export interface PronunciationDrill {
  word: string;
  phoneme: string;
  ipa: string;
  instruction: string;
}

export interface ExerciseRecord extends Exercise {
  completedAt: number;
  language: string;
}

export interface Language {
  code: string;
  name: string;
  flag: string;
}

export const LANGUAGES: Language[] = [
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'fr', name: 'French', flag: '🇫🇷' }
];
