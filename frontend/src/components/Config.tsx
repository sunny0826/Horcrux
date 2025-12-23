import { useEffect, useState } from 'react';
import { 
  Palette
} from 'lucide-react';

type ThemeOption = 'light' | 'dark' | 'system';

type ConfigProps = {
  theme: ThemeOption;
  setTheme: (newTheme: ThemeOption) => void;
};

export const Config = ({ theme, setTheme }: ConfigProps) => {
  const [activeSection, setActiveSection] = useState('appearance');
  const [draftTheme, setDraftTheme] = useState<ThemeOption>(theme);

  const isDirty = draftTheme !== theme;

  useEffect(() => {
    setDraftTheme(theme);
  }, [theme]);

  const handleResetDefaults = () => {
    setDraftTheme('system');
    setTheme('system');
  };

  const handleApplyChanges = () => {
    setTheme(draftTheme);
  };

  const categories = [
    { id: 'appearance', label: 'Appearance', icon: Palette },
  ];

  return (
    <div className="h-full w-full bg-background overflow-hidden flex flex-col p-8">
      <div className="flex justify-between items-center mb-8 shrink-0">
        <div>
          <h2 className="text-xl font-bold text-primary tracking-widest uppercase">System_Configuration</h2>
          <p className="text-[10px] text-textMain/60 mt-1 font-mono">{'>'} MODIFIED_TIMESTAMP: {new Date().toISOString().replace('T', ' ').split('.')[0]} [KERNEL_SYNC_ACTIVE]</p>
        </div>
        <div className="flex space-x-4">
          <button
            type="button"
            onClick={handleResetDefaults}
            className="btn-secondary !px-4"
          >
            Reset_Defaults
          </button>
          <button
            type="button"
            onClick={handleApplyChanges}
            disabled={!isDirty}
            className={[
              'btn-primary !px-6',
              !isDirty ? 'opacity-50 cursor-not-allowed' : '',
            ].join(' ')}
          >
            Apply_Changes
          </button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-8 flex-1 min-h-0">
        {/* Left Column: Categories */}
        <div className="col-span-3 space-y-2 overflow-y-auto pr-2">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveSection(cat.id)}
              className={`w-full text-left px-4 py-3 text-[10px] uppercase font-bold tracking-widest transition-all flex items-center ${
                activeSection === cat.id
                  ? 'bg-primary/10 text-primary border-l-2 border-primary'
                  : 'hover:bg-panel text-textMain/60 hover:text-textMain'
              }`}
            >
              <cat.icon className="w-4 h-4 mr-3" />
              {cat.label}
            </button>
          ))}
        </div>

        {/* Right Column: Settings Form */}
        <div className="col-span-9 bg-panel border border-border p-8 space-y-10 overflow-y-auto">
          
          {/* Appearance Section */}
          {activeSection === 'appearance' && (
            <section className="space-y-6 animate-in fade-in duration-300">
              <div className="flex items-center space-x-4 border-b border-border pb-2">
                <span className="text-[11px] font-bold text-textMain uppercase tracking-[0.2em]">Appearance_Settings</span>
                <div className="flex-1 h-[1px] bg-border"></div>
              </div>

              <div className="form-group-geek space-y-3">
                <label className="text-[9px] text-textMain/60 uppercase block tracking-tighter">Theme_Mode</label>
                <div className="flex space-x-8">
                  {[
                    { value: 'light', label: 'Light_Mode' },
                    { value: 'dark', label: 'Dark_Mode' },
                    { value: 'system', label: 'System_Auto' }
                  ].map((option) => (
                    <label key={option.value} className="flex items-center space-x-2 cursor-pointer group">
                      <div className="relative flex items-center">
                        <input
                          type="radio"
                          name="theme"
                          value={option.value}
                          checked={draftTheme === option.value}
                          onChange={() => setDraftTheme(option.value as ThemeOption)}
                          className="sr-only"
                        />
                        <div className={`w-3 h-3 border transition-colors flex items-center justify-center ${
                          draftTheme === option.value ? 'border-primary' : 'border-textMain/40 group-hover:border-primary'
                        }`}>
                          <div className={`w-1.5 h-1.5 bg-primary transition-opacity ${
                            draftTheme === option.value ? 'opacity-100' : 'opacity-0'
                          }`}></div>
                        </div>
                      </div>
                      <span className={`text-[9px] uppercase tracking-widest transition-colors ${
                        draftTheme === option.value ? 'text-primary' : 'text-textMain/60 group-hover:text-primary'
                      }`}>
                        {option.label}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="text-[8px] text-textMain/40 pt-1">
                  Select the interface color scheme. System_Auto will sync with your OS settings.
                </p>
              </div>
            </section>
          )}

        </div>
      </div>
    </div>
  );
};
