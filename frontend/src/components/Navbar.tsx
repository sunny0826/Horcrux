import { useState } from 'react';
import { 
  Terminal, 
  Cpu, 
  ShieldAlert, 
  History, 
  Settings, 
  User,
  Workflow,
  Plus,
  Menu,
  X
} from 'lucide-react';

interface NavbarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onOpenImageLoader: () => void;
  appVersion: string;
}

export function Navbar({ activeTab, setActiveTab, onOpenImageLoader, appVersion }: NavbarProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const navItems = [
    { id: 'dashboard', label: 'Core.Dashboard', icon: Cpu },
    { id: 'designer', label: 'Flow.Designer', icon: Workflow },
    { id: 'vault', label: 'Auth.Vault', icon: ShieldAlert },
    { id: 'history', label: 'Sync.History', icon: History },
    { id: 'config', label: 'Sys.Config', icon: Settings },
  ];

  return (
    <header className="border-b border-border bg-background z-50 shrink-0 sticky top-0">
      <div className="flex items-center justify-between px-6 h-16">
        {/* Left Section: Logo & Desktop Nav */}
        <div className="flex items-center space-x-8">
          <div className="flex items-center space-x-3 pr-8 lg:border-r border-border">
            <div className="w-8 h-8 border border-primary flex items-center justify-center">
              <Terminal className="text-primary w-4 h-4" />
            </div>
            <h1 className="text-lg font-bold tracking-widest text-primary">HORCRUX</h1>
          </div>

          {/* Desktop Navigation */}
          <nav className="hidden lg:flex items-center space-x-1">
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex items-center space-x-2 px-4 h-16 transition-all border-b-2 ${
                  activeTab === item.id 
                    ? 'bg-primary/10 text-primary border-primary' 
                    : 'hover:bg-panel text-textMain/60 hover:text-primary border-transparent'
                }`}
              >
                <item.icon className="w-4 h-4" />
                <span className="text-[11px] uppercase tracking-tighter font-bold">{item.label}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Right Section: Desktop Actions */}
        <div className="hidden lg:flex items-center space-x-8">
          <div className="flex items-center space-x-4">
            <span className="text-textMain/40 text-[10px]">ROOT@HORCRUX:~/SYNC_TASKS$</span>
            <span className="animate-pulse w-2 h-4 bg-primary"></span>
          </div>
          
          <div className="flex items-center space-x-6">
            <button 
              onClick={onOpenImageLoader}
              className="text-[10px] text-primary hover:bg-primary/10 px-4 py-1.5 border border-primary transition uppercase tracking-widest font-bold flex items-center gap-2"
            >
              <Plus className="w-3 h-3" />
              Load Image Archive
            </button>
            
            <div className="flex items-center space-x-6 pl-6 border-l border-border">
              <div className="flex flex-col items-end">
                <span className="text-[9px] text-dim">● KERNEL_READY</span>
                <span className="text-[8px] text-textMain/40 mt-0.5">{appVersion}</span>
              </div>
              <div className="w-8 h-8 border border-border flex items-center justify-center bg-panel">
                <User className="w-4 h-4 text-textMain/60" />
              </div>
            </div>
          </div>
        </div>

        {/* Mobile Menu Button */}
        <div className="lg:hidden flex items-center">
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="text-primary p-2 focus:outline-none"
          >
            {isMobileMenuOpen ? (
              <X className="w-6 h-6" />
            ) : (
              <Menu className="w-6 h-6" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile Menu Dropdown */}
      <div 
        className={`lg:hidden bg-panel border-b border-border transition-all duration-300 ease-in-out overflow-hidden ${
          isMobileMenuOpen ? 'max-h-screen opacity-100 py-4' : 'max-h-0 opacity-0 py-0'
        }`}
      >
        <div className="flex flex-col space-y-2 px-6">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setActiveTab(item.id);
                setIsMobileMenuOpen(false);
              }}
              className={`flex items-center space-x-4 px-4 py-3 border-l-2 transition-all w-full text-left ${
                activeTab === item.id 
                  ? 'bg-primary/10 text-primary border-primary' 
                  : 'text-textMain/60 hover:text-primary border-transparent hover:bg-background'
              }`}
            >
              <item.icon className="w-5 h-5" />
              <span className="text-sm uppercase tracking-wider font-bold">{item.label}</span>
            </button>
          ))}
          
          <div className="h-px bg-border my-4" />

          <button 
            onClick={() => {
              onOpenImageLoader();
              setIsMobileMenuOpen(false);
            }}
            className="flex items-center space-x-3 text-primary hover:bg-primary/10 px-4 py-3 border border-primary transition uppercase tracking-widest font-bold w-full justify-center"
          >
            <Plus className="w-4 h-4" />
            <span>Load Image Archive</span>
          </button>

          <div className="flex items-center justify-between pt-4 px-2">
            <div className="flex flex-col">
              <span className="text-[10px] text-dim">● KERNEL_READY</span>
              <span className="text-[9px] text-textMain/40 mt-0.5">{appVersion}</span>
            </div>
             <div className="w-8 h-8 border border-border flex items-center justify-center bg-background">
                <User className="w-4 h-4 text-textMain/60" />
              </div>
          </div>
        </div>
      </div>
    </header>
  );
}
