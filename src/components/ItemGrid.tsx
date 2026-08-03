import React from 'react';
import { 
  Wifi, 
  Coffee, 
  CupSoda, 
  GlassWater, 
  Croissant, 
  Utensils, 
  Cookie, 
  BatteryCharging, 
  Cable, 
  Monitor, 
  Zap, 
  Plus, 
  Clock, 
  Sparkles 
} from 'lucide-react';
import { POSItem, POSItemCategory } from '../types';
import { formatCurrency } from '../data';

interface ItemGridProps {
  items: POSItem[];
  selectedCategory: POSItemCategory;
  onSelectCategory: (category: POSItemCategory) => void;
  onAddItem: (item: POSItem) => void;
}

const CATEGORY_TABS: { id: POSItemCategory; label: string; countBadge?: string }[] = [
  { id: 'all', label: 'All Items' },
  { id: 'wifi', label: 'Wi-Fi Vouchers' },
  { id: 'cafe', label: 'Cafe & Drinks' },
  { id: 'snacks', label: 'Bakery & Snacks' },
  { id: 'hardware', label: 'Hardware & Pods' },
];

export const ItemGrid: React.FC<ItemGridProps> = ({
  items,
  selectedCategory,
  onSelectCategory,
  onAddItem,
}) => {
  const filteredItems = selectedCategory === 'all'
    ? items
    : items.filter((item) => item.category === selectedCategory);

  const getIcon = (iconName: string) => {
    const props = { className: 'w-5 h-5' };
    switch (iconName) {
      case 'Wifi': return <Wifi {...props} />;
      case 'Zap': return <Zap {...props} />;
      case 'Coffee': return <Coffee {...props} />;
      case 'CupSoda': return <CupSoda {...props} />;
      case 'GlassWater': return <GlassWater {...props} />;
      case 'Croissant': return <Croissant {...props} />;
      case 'Utensils': return <Utensils {...props} />;
      case 'Cookie': return <Cookie {...props} />;
      case 'BatteryCharging': return <BatteryCharging {...props} />;
      case 'Cable': return <Cable {...props} />;
      case 'Monitor': return <Monitor {...props} />;
      default: return <Wifi {...props} />;
    }
  };

  return (
    <div className="flex flex-col h-full bg-transparent">
      {/* Category Tabs Header */}
      <div className="flex items-center justify-between pb-4 border-b border-gray-200">
        <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
          {CATEGORY_TABS.map((tab) => {
            const isActive = selectedCategory === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => onSelectCategory(tab.id)}
                className={`px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all cursor-pointer ${
                  isActive
                    ? 'bg-gray-900 text-white shadow-xs'
                    : 'bg-white text-gray-600 hover:bg-gray-100 border border-gray-200/80'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="hidden sm:block text-xs text-gray-500">
          Showing <span className="font-semibold text-gray-900">{filteredItems.length}</span> items
        </div>
      </div>

      {/* Grid Content */}
      <div className="flex-1 overflow-y-auto py-4 pr-1">
        {filteredItems.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center text-gray-400 bg-white/50 rounded-2xl border border-dashed border-gray-200 p-8">
            <Wifi className="w-10 h-10 mb-3 text-gray-300 stroke-[1.5]" />
            <p className="text-sm font-medium text-gray-600">No items found in this category</p>
            <p className="text-xs text-gray-400 mt-1">Try adjusting your search filter or selecting another tab.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filteredItems.map((item) => {
              const isWifi = item.category === 'wifi';
              return (
                <button
                  key={item.id}
                  onClick={() => onAddItem(item)}
                  className={`group relative text-left p-4 rounded-2xl border transition-all duration-150 flex flex-col justify-between h-44 cursor-pointer overflow-hidden ${
                    isWifi
                      ? 'bg-white border-emerald-200/80 hover:border-emerald-500 hover:shadow-md hover:shadow-emerald-500/5'
                      : 'bg-white border-gray-200 hover:border-gray-900 hover:shadow-md'
                  }`}
                >
                  {/* Top Badge Row */}
                  <div className="flex items-start justify-between w-full">
                    <div className={`p-2.5 rounded-xl flex items-center justify-center transition-transform group-hover:scale-105 ${
                      isWifi
                        ? 'bg-emerald-50 text-emerald-600'
                        : 'bg-gray-100 text-gray-700'
                    }`}>
                      {getIcon(item.iconName)}
                    </div>

                    <div className="flex items-center gap-1.5">
                      {item.isPopular && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-800 text-[10px] font-semibold">
                          <Sparkles className="w-2.5 h-2.5" />
                          Popular
                        </span>
                      )}
                      {isWifi && item.bandwidthMbps && (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-100/80 text-emerald-800 text-[10px] font-mono font-bold">
                          {item.bandwidthMbps} Mbps
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Title & Description */}
                  <div className="mt-2">
                    <h3 className="text-sm font-bold text-gray-900 line-clamp-1 group-hover:text-emerald-700 transition-colors">
                      {item.name}
                    </h3>
                    <p className="text-xs text-gray-500 line-clamp-2 mt-1 leading-relaxed">
                      {item.description}
                    </p>
                  </div>

                  {/* Price Footer */}
                  <div className="flex items-center justify-between pt-3 border-t border-gray-100 mt-2">
                    <div className="flex items-baseline gap-1">
                      <span className="text-base font-bold text-gray-900 font-mono">
                        {formatCurrency(item.price)}
                      </span>
                      {isWifi && item.durationMinutes && (
                        <span className="text-[11px] text-gray-400 flex items-center gap-0.5">
                          <Clock className="w-3 h-3 inline" />
                          {item.durationMinutes >= 1440
                            ? `${item.durationMinutes / 1440}d`
                            : `${item.durationMinutes / 60}h`}
                        </span>
                      )}
                    </div>

                    <div className="h-8 w-8 rounded-lg bg-gray-100 group-hover:bg-emerald-600 group-hover:text-white flex items-center justify-center transition-colors">
                      <Plus className="w-4 h-4" />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
