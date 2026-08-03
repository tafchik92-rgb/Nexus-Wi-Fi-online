import React, { useState } from 'react';
import { X, Plus, Wifi, Coffee, Croissant, Monitor, DollarSign } from 'lucide-react';
import { POSItem, POSItemCategory } from '../types';

interface CustomItemModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddCustomItem: (item: POSItem) => void;
}

export const CustomItemModal: React.FC<CustomItemModalProps> = ({
  isOpen,
  onClose,
  onAddCustomItem,
}) => {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('5.00');
  const [category, setCategory] = useState<Exclude<POSItemCategory, 'all'>>('wifi');
  const [description, setDescription] = useState('');
  const [durationMinutes, setDurationMinutes] = useState('120');
  const [bandwidthMbps, setBandwidthMbps] = useState('150');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const numericPrice = parseFloat(price);
    if (!name.trim() || isNaN(numericPrice) || numericPrice < 0) return;

    const isWifi = category === 'wifi';
    const customItem: POSItem = {
      id: `custom-${Date.now()}`,
      name: name.trim(),
      price: numericPrice,
      category,
      description: description.trim() || 'Custom cashier item',
      iconName: isWifi ? 'Wifi' : category === 'cafe' ? 'Coffee' : category === 'snacks' ? 'Croissant' : 'Monitor',
      ...(isWifi && {
        durationMinutes: parseInt(durationMinutes, 10) || 60,
        bandwidthMbps: parseInt(bandwidthMbps, 10) || 100,
      }),
    };

    onAddCustomItem(customItem);
    setName('');
    setPrice('5.00');
    setDescription('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-xl border border-gray-200 max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-gray-900 text-white flex items-center justify-center">
              <Plus className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-gray-900">Add Custom Price Item</h2>
              <p className="text-xs text-gray-500">Ad-hoc voucher or special charge</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 rounded-xl hover:bg-gray-200 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1">
              Item Name *
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. 2-Hour VIP Wi-Fi Pass / Custom Coffee"
              className="w-full px-3.5 py-2 text-xs bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">
                Price (USD) *
              </label>
              <div className="relative">
                <DollarSign className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="number"
                  step="0.25"
                  min="0"
                  required
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-xs font-mono font-bold bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">
                Category
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Exclude<POSItemCategory, 'all'>)}
                className="w-full px-3 py-2 text-xs bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 font-medium"
              >
                <option value="wifi">Wi-Fi Voucher</option>
                <option value="cafe">Cafe & Drink</option>
                <option value="snacks">Bakery & Snack</option>
                <option value="hardware">Hardware / Pod</option>
              </select>
            </div>
          </div>

          {category === 'wifi' && (
            <div className="grid grid-cols-2 gap-3 p-3 bg-emerald-50/70 border border-emerald-100 rounded-2xl">
              <div>
                <label className="block text-[11px] font-semibold text-emerald-900 mb-1">
                  Duration (Minutes)
                </label>
                <input
                  type="number"
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs font-mono font-bold bg-white border border-emerald-200 rounded-xl focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-emerald-900 mb-1">
                  Speed (Mbps)
                </label>
                <input
                  type="number"
                  value={bandwidthMbps}
                  onChange={(e) => setBandwidthMbps(e.target.value)}
                  className="w-full px-3 py-1.5 text-xs font-mono font-bold bg-white border border-emerald-200 rounded-xl focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1">
              Description (optional)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief note or description..."
              className="w-full px-3.5 py-2 text-xs bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl text-xs font-semibold text-gray-600 hover:bg-gray-100 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-sm transition-all cursor-pointer"
            >
              Add Item to Order
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
