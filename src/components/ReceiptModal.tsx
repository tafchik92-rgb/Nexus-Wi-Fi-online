import React, { useState } from 'react';
import { 
  X, 
  Printer, 
  Copy, 
  Check, 
  Wifi, 
  QrCode, 
  Clock, 
  Zap, 
  CheckCircle2, 
  Calendar,
  Share2
} from 'lucide-react';
import { TransactionReceipt, WiFiVoucher } from '../types';
import { formatCurrency } from '../data';

interface ReceiptModalProps {
  receipt: TransactionReceipt | null;
  onClose: () => void;
}

export const ReceiptModal: React.FC<ReceiptModalProps> = ({ receipt, onClose }) => {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  if (!receipt) return null;

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  const handleCopyAllCodes = () => {
    const codes = receipt.vouchers.map((v) => `${v.durationLabel}: ${v.code}`).join('\n');
    navigator.clipboard.writeText(codes);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-xl border border-gray-200 max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gray-50">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-emerald-600 text-white flex items-center justify-center shadow-xs">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-gray-900">Transaction Complete</h2>
              <p className="text-xs text-gray-500 font-mono">Receipt #{receipt.id}</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 rounded-xl hover:bg-gray-200 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Receipt Area */}
        <div id="printable-receipt" className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Top Brand Banner for Printable View */}
          <div className="text-center pb-4 border-b border-dashed border-gray-200">
            <h3 className="text-lg font-bold text-gray-900">Nexus Wi-Fi Lounge & Cafe</h3>
            <p className="text-xs text-gray-500 mt-0.5">High-Speed Fiber Hotspot • Access Vouchers</p>
            <p className="text-[11px] text-gray-400 font-mono mt-1">{receipt.timestamp}</p>
            {receipt.customerReference && (
              <p className="text-xs font-semibold text-emerald-700 mt-2">
                Customer / Table: {receipt.customerReference}
              </p>
            )}
          </div>

          {/* Wi-Fi Voucher Cards (if any were generated) */}
          {receipt.vouchers.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
                  <Wifi className="w-4 h-4 text-emerald-600" />
                  <span>Wi-Fi Access Vouchers ({receipt.vouchers.length})</span>
                </h4>

                {receipt.vouchers.length > 1 && (
                  <button
                    onClick={handleCopyAllCodes}
                    className="text-xs text-emerald-600 hover:text-emerald-700 font-medium flex items-center gap-1 cursor-pointer"
                  >
                    {copiedAll ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        <span>Copied All</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy All Codes</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {receipt.vouchers.map((voucher, idx) => (
                  <div
                    key={idx}
                    className="p-4 rounded-2xl bg-gray-900 text-white border border-gray-800 flex flex-col justify-between space-y-3 relative overflow-hidden"
                  >
                    {/* Top Row: SSID & Bandwidth */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-gray-300">
                        <Wifi className="w-4 h-4 text-emerald-400" />
                        <span>{voucher.ssid}</span>
                      </div>
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                        {voucher.bandwidthMbps} Mbps
                      </span>
                    </div>

                    {/* Voucher Title */}
                    <div>
                      <h5 className="text-xs font-semibold text-gray-400">{voucher.durationLabel}</h5>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-base font-bold font-mono tracking-wider text-emerald-400">
                          {voucher.code}
                        </span>
                        <button
                          onClick={() => handleCopyCode(voucher.code)}
                          className="p-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors cursor-pointer"
                          title="Copy voucher code"
                        >
                          {copiedCode === voucher.code ? (
                            <Check className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Expiry Footer */}
                    <div className="pt-2 border-t border-gray-800 flex items-center justify-between text-[11px] text-gray-400">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5 text-gray-500" />
                        Expires: {voucher.expiresAt}
                      </span>
                      <QrCode className="w-5 h-5 text-gray-500" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Itemized Order Breakdown */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500">
              Purchased Items
            </h4>
            <div className="bg-gray-50 rounded-2xl border border-gray-200 p-4 divide-y divide-gray-200/80">
              {receipt.items.map((line, i) => (
                <div key={i} className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between text-xs">
                  <div>
                    <span className="font-semibold text-gray-900">{line.item.name}</span>
                    <span className="text-gray-500 ml-1 font-mono">x{line.quantity}</span>
                  </div>
                  <span className="font-mono font-medium text-gray-900">
                    {formatCurrency(line.item.price * line.quantity)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Total & Tax Summary */}
          <div className="border-t border-gray-200 pt-4 space-y-1.5 text-xs">
            <div className="flex justify-between text-gray-600">
              <span>Subtotal</span>
              <span className="font-mono">{formatCurrency(receipt.subtotal)}</span>
            </div>
            <div className="flex justify-between text-gray-600">
              <span>Tax (8%)</span>
              <span className="font-mono">{formatCurrency(receipt.tax)}</span>
            </div>
            <div className="flex justify-between text-sm font-bold text-gray-900 pt-2 border-t border-gray-200">
              <span>Total Paid ({receipt.paymentMethod.toUpperCase()})</span>
              <span className="font-mono text-emerald-700">{formatCurrency(receipt.total)}</span>
            </div>
          </div>
        </div>

        {/* Modal Actions */}
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-3">
          <button
            onClick={handlePrint}
            className="px-4 py-2.5 rounded-xl bg-white hover:bg-gray-100 text-gray-800 border border-gray-200 text-xs font-semibold flex items-center gap-1.5 shadow-2xs transition-all cursor-pointer"
          >
            <Printer className="w-4 h-4" />
            <span>Print Receipt & Vouchers</span>
          </button>

          <button
            onClick={onClose}
            className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-sm transition-all cursor-pointer"
          >
            New Sale / Done
          </button>
        </div>
      </div>
    </div>
  );
};
