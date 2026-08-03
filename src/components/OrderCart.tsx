import React, { useState } from 'react';
import { 
  ShoppingCart, 
  Trash2, 
  Plus, 
  Minus, 
  Wifi, 
  CreditCard, 
  Banknote, 
  QrCode, 
  Sparkles, 
  User, 
  FileText,
  ChevronRight
} from 'lucide-react';
import { OrderItem } from '../types';
import { formatCurrency } from '../data';

interface OrderCartProps {
  orderItems: OrderItem[];
  customerReference: string;
  onCustomerReferenceChange: (ref: string) => void;
  onUpdateQuantity: (itemId: string, delta: number) => void;
  onRemoveItem: (itemId: string) => void;
  onClearOrder: () => void;
  onCheckout: (paymentMethod: 'cash' | 'card' | 'qr') => void;
}

export const OrderCart: React.FC<OrderCartProps> = ({
  orderItems,
  customerReference,
  onCustomerReferenceChange,
  onUpdateQuantity,
  onRemoveItem,
  onClearOrder,
  onCheckout,
}) => {
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'qr'>('card');

  const subtotal = orderItems.reduce(
    (acc, line) => acc + line.item.price * line.quantity,
    0
  );
  const taxRate = 0.08; // 8% sales tax
  const tax = subtotal * taxRate;
  const total = subtotal + tax;

  const totalItemCount = orderItems.reduce((acc, line) => acc + line.quantity, 0);
  const wifiVoucherCount = orderItems
    .filter((line) => line.item.category === 'wifi')
    .reduce((acc, line) => acc + line.quantity, 0);

  return (
    <div className="bg-white border border-gray-200 rounded-2xl flex flex-col h-full shadow-xs overflow-hidden">
      {/* Cart Header */}
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/60">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gray-900 text-white flex items-center justify-center">
            <ShoppingCart className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-gray-900">Current Order</h2>
            <p className="text-[11px] text-gray-500">
              {totalItemCount} {totalItemCount === 1 ? 'item' : 'items'} in ticket
            </p>
          </div>
        </div>

        {orderItems.length > 0 && (
          <button
            onClick={onClearOrder}
            className="text-xs font-semibold text-red-600 hover:text-red-700 hover:bg-red-50 px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer flex items-center gap-1"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear</span>
          </button>
        )}
      </div>

      {/* Customer / Table Input */}
      <div className="px-4 py-2.5 border-b border-gray-100 bg-white">
        <div className="relative">
          <User className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={customerReference}
            onChange={(e) => onCustomerReferenceChange(e.target.value)}
            placeholder="Customer Name or Table # (optional)"
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded-xl focus:bg-white focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/20"
          />
        </div>
      </div>

      {/* Order Item List */}
      <div className="flex-1 overflow-y-auto px-4 py-3 divide-y divide-gray-100">
        {orderItems.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-gray-400">
            <div className="h-14 w-14 rounded-2xl bg-gray-100 flex items-center justify-center mb-3">
              <ShoppingCart className="w-6 h-6 text-gray-400" />
            </div>
            <p className="text-sm font-semibold text-gray-700">Ticket is empty</p>
            <p className="text-xs text-gray-400 mt-1">
              Select Wi-Fi vouchers or cafe items from the grid to build an order.
            </p>
          </div>
        ) : (
          orderItems.map((line) => {
            const isWifi = line.item.category === 'wifi';
            const lineTotal = line.item.price * line.quantity;
            return (
              <div key={line.item.id} className="py-3 first:pt-1 last:pb-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5">
                    <div className={`mt-0.5 h-7 w-7 rounded-lg flex items-center justify-center shrink-0 ${
                      isWifi ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-700'
                    }`}>
                      {isWifi ? <Wifi className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-gray-900 leading-snug">
                        {line.item.name}
                      </h4>
                      <div className="text-[11px] text-gray-500 font-mono mt-0.5">
                        {formatCurrency(line.item.price)} each
                      </div>
                      {isWifi && (
                        <span className="inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          Instant Voucher
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <span className="text-xs font-bold text-gray-900 font-mono block">
                      {formatCurrency(lineTotal)}
                    </span>
                  </div>
                </div>

                {/* Quantity Controls */}
                <div className="flex items-center justify-between mt-2.5 pl-9">
                  <div className="flex items-center border border-gray-200 rounded-lg bg-gray-50 overflow-hidden">
                    <button
                      onClick={() => onUpdateQuantity(line.item.id, -1)}
                      className="px-2 py-1 hover:bg-gray-200 text-gray-700 transition-colors cursor-pointer"
                      title="Decrease quantity"
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                    <span className="px-3 py-0.5 text-xs font-mono font-bold text-gray-900 bg-white">
                      {line.quantity}
                    </span>
                    <button
                      onClick={() => onUpdateQuantity(line.item.id, 1)}
                      className="px-2 py-1 hover:bg-gray-200 text-gray-700 transition-colors cursor-pointer"
                      title="Increase quantity"
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>

                  <button
                    onClick={() => onRemoveItem(line.item.id)}
                    className="text-[11px] text-gray-400 hover:text-red-600 transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Voucher Generation Info Banner */}
      {wifiVoucherCount > 0 && (
        <div className="px-4 py-2 bg-emerald-50/80 border-t border-b border-emerald-100 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-emerald-600 shrink-0" />
          <p className="text-[11px] text-emerald-800">
            Will generate <span className="font-bold">{wifiVoucherCount}</span> unique Wi-Fi access voucher {wifiVoucherCount === 1 ? 'code' : 'codes'} upon checkout.
          </p>
        </div>
      )}

      {/* Payment Method Selector & Totals */}
      <div className="p-4 bg-gray-50/90 border-t border-gray-200 space-y-3">
        {/* Payment Methods */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { id: 'card', label: 'Card', icon: CreditCard },
            { id: 'cash', label: 'Cash', icon: Banknote },
            { id: 'qr', label: 'QR Scan', icon: QrCode },
          ].map((method) => {
            const Icon = method.icon;
            const isSelected = paymentMethod === method.id;
            return (
              <button
                key={method.id}
                onClick={() => setPaymentMethod(method.id as 'cash' | 'card' | 'qr')}
                className={`flex flex-col items-center justify-center py-2 px-1 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${
                  isSelected
                    ? 'bg-gray-900 text-white border-gray-900 shadow-xs'
                    : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5 mb-1" />
                <span>{method.label}</span>
              </button>
            );
          })}
        </div>

        {/* Cost Breakdown */}
        <div className="space-y-1.5 pt-1 text-xs">
          <div className="flex justify-between text-gray-600">
            <span>Subtotal</span>
            <span className="font-mono font-medium">{formatCurrency(subtotal)}</span>
          </div>
          <div className="flex justify-between text-gray-600">
            <span>Tax (8%)</span>
            <span className="font-mono font-medium">{formatCurrency(tax)}</span>
          </div>
          <div className="flex justify-between text-sm font-bold text-gray-900 pt-1 border-t border-gray-200">
            <span>Total</span>
            <span className="font-mono text-emerald-700">{formatCurrency(total)}</span>
          </div>
        </div>

        {/* Checkout Button */}
        <button
          disabled={orderItems.length === 0}
          onClick={() => onCheckout(paymentMethod)}
          className={`w-full py-3.5 rounded-xl text-sm font-bold shadow-sm flex items-center justify-center gap-2 transition-all cursor-pointer ${
            orderItems.length === 0
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
              : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/20 hover:shadow-md'
          }`}
        >
          <span>Complete Sale</span>
          <span className="font-mono text-xs px-2 py-0.5 rounded bg-white/20">
            {formatCurrency(total)}
          </span>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
