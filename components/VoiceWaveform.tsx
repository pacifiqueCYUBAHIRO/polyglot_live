
import React from 'react';

interface VoiceWaveformProps {
  isActive: boolean;
  color?: string;
}

const VoiceWaveform: React.FC<VoiceWaveformProps> = ({ isActive, color = '#3b82f6' }) => {
  return (
    <div className="flex items-center justify-center gap-1 h-12 w-32">
      {[...Array(8)].map((_, i) => (
        <div
          key={i}
          className={`w-1 rounded-full transition-all duration-300 ${isActive ? 'animate-bounce' : 'h-1'}`}
          style={{
            backgroundColor: color,
            height: isActive ? `${Math.random() * 100 + 20}%` : '4px',
            animationDelay: `${i * 0.1}s`,
            animationDuration: '0.6s'
          }}
        />
      ))}
    </div>
  );
};

export default VoiceWaveform;
