import React, { useState, useEffect } from 'react';
import { Wifi, Search, Clock, History, Signal, Plus, RefreshCw } from 'lucide-react';

interface HeaderProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onOpenHistory: () => void;
  onOpenCustomItem: () => void;
  completedTransactionsCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  searchQuery,
  onSearchChange,
  onOpenHistory,
  onOpenCustomItem,
  completedTransactionsCount,
}) => {
  const [currentTime, setCurrentTime] = useState<string>('');

  useEffect(() => {
    const updateTime = () => {
      setCurrentTime(
        new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="bg-white border-b border-gray-200 px-6 py-4 flex flex-col md:flex-row items-center justify-between gap-4 shadow-2xs">
      {/* Brand Title & Status Pill */}
      <div className="flex items-center gap-4 w-full md:w-auto justify-between md:justify-start">
        <div className="flex items-center gap-2.5">
          <div className="h-10 w-10 rounded-xl bg-emerald-600 flex items-center justify-center text-white shadow-xs">
            <Wifi className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-gray-900 flex items-center gap-2">
              Nexus Wi-Fi POS
            </h1>
            <p className="text-xs text-gray-500">
              Hotspot Voucher & Cafe Billing
            </p>
          </div>
        </div>

        {/* Live Network Pill */}
        <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-medium">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          <Signal className="w-3.5 h-3.5 text-emerald-600" />
          <span>SSID: Nexus_Guest_5G</span>
          <span className="text-emerald-300">•</span>
          <span className="text-emerald-700 font-mono">100–300 Mbps</span>
        </div>
      </div>

      {/* Search Input */}
      <div className="relative flex-1 max-w-md w-full">
        <Search className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search items, vouchers, cafe drinks..."
          className="w-full pl-10 pr-4 py-2 text-sm bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 transition-all"
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600"
          >
            Clear
          </button>
        )}
      </div>

      {/* Action Buttons & Time */}
      <div className="flex items-center gap-3 w-full md:w-auto justify-end">
        <button
          onClick={onOpenCustomItem}
          className="px-3.5 py-2 text-xs font-medium bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-xl flex items-center gap-1.5 transition-colors cursor-pointer"
          title="Add custom price item to current order"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Custom Item</span>
        </button>

        <button
          onClick={onOpenHistory}
          className="px-3.5 py-2 text-xs font-medium bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-xl flex items-center gap-1.5 transition-colors relative cursor-pointer"
          title="View completed sales & reprint vouchers"
        >
          <History className="w-3.5 h-3.5" />
          <span>Sales Log</span>
          {completedTransactionsCount > 0 && (
            <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-emerald-600 text-white">
              {completedTransactionsCount}
            </span>
          )}
        </button>

        {/* Live Clock */}
        <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono font-medium text-gray-600 pl-2 border-l border-gray-200">
          <Clock className="w-3.5 h-3.5 text-gray-400" />
          <span>{currentTime || '--:--'}</span>
        </div>
      </div>
    </header>
  );
};
