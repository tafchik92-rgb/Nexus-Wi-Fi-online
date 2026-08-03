/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { Header } from './components/Header';
import { ItemGrid } from './components/ItemGrid';
import { OrderCart } from './components/OrderCart';
import { ReceiptModal } from './components/ReceiptModal';
import { HistoryModal } from './components/HistoryModal';
import { CustomItemModal } from './components/CustomItemModal';
import { 
  POSItem, 
  POSItemCategory, 
  OrderItem, 
  TransactionReceipt, 
  WiFiVoucher 
} from './types';
import { INITIAL_POS_ITEMS, generateWiFiVoucher } from './data';

export default function App() {
  const [items, setItems] = useState<POSItem[]>(INITIAL_POS_ITEMS);
  const [selectedCategory, setSelectedCategory] = useState<POSItemCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [customerReference, setCustomerReference] = useState('');
  const [transactions, setTransactions] = useState<TransactionReceipt[]>([]);
  
  // Modals state
  const [activeReceipt, setActiveReceipt] = useState<TransactionReceipt | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isCustomItemOpen, setIsCustomItemOpen] = useState(false);

  // Filter items by search query
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q)
    );
  }, [items, searchQuery]);

  // Cart actions
  const handleAddItem = (item: POSItem) => {
    setOrderItems((prev) => {
      const existingIndex = prev.findIndex((line) => line.item.id === item.id);
      if (existingIndex > -1) {
        const updated = [...prev];
        updated[existingIndex] = {
          ...updated[existingIndex],
          quantity: updated[existingIndex].quantity + 1,
        };
        return updated;
      }
      return [...prev, { item, quantity: 1 }];
    });
  };

  const handleUpdateQuantity = (itemId: string, delta: number) => {
    setOrderItems((prev) => {
      return prev
        .map((line) => {
          if (line.item.id === itemId) {
            const nextQty = line.quantity + delta;
            return nextQty > 0 ? { ...line, quantity: nextQty } : null;
          }
          return line;
        })
        .filter(Boolean) as OrderItem[];
    });
  };

  const handleRemoveItem = (itemId: string) => {
    setOrderItems((prev) => prev.filter((line) => line.item.id !== itemId));
  };

  const handleClearOrder = () => {
    setOrderItems([]);
    setCustomerReference('');
  };

  const handleAddCustomItem = (customItem: POSItem) => {
    setItems((prev) => [customItem, ...prev]);
    handleAddItem(customItem);
  };

  const handleCheckout = (paymentMethod: 'cash' | 'card' | 'qr') => {
    if (orderItems.length === 0) return;

    // Calculate totals
    const subtotal = orderItems.reduce(
      (acc, line) => acc + line.item.price * line.quantity,
      0
    );
    const taxRate = 0.08;
    const tax = subtotal * taxRate;
    const total = subtotal + tax;

    // Generate vouchers for Wi-Fi items
    const generatedVouchers: WiFiVoucher[] = [];
    orderItems.forEach((line) => {
      if (line.item.category === 'wifi') {
        for (let i = 0; i < line.quantity; i++) {
          generatedVouchers.push(generateWiFiVoucher(line.item));
        }
      }
    });

    const now = new Date();
    const newReceipt: TransactionReceipt = {
      id: Math.floor(100000 + Math.random() * 900000).toString(),
      timestamp: now.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
      items: orderItems,
      subtotal,
      taxRate,
      tax,
      total,
      paymentMethod,
      vouchers: generatedVouchers,
      customerReference: customerReference.trim() || undefined,
    };

    setTransactions((prev) => [newReceipt, ...prev]);
    setActiveReceipt(newReceipt);
    handleClearOrder();
  };

  return (
    <div className="min-h-screen h-screen flex flex-col bg-[#f6f7f9] text-gray-900 overflow-hidden select-none">
      {/* Top Header Navigation */}
      <Header
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onOpenHistory={() => setIsHistoryOpen(true)}
        onOpenCustomItem={() => setIsCustomItemOpen(true)}
        completedTransactionsCount={transactions.length}
      />

      {/* Main Single-Screen POS Workspace */}
      <main className="flex-1 overflow-hidden p-4 md:p-6 flex flex-col lg:flex-row gap-6">
        {/* Left Section: Item Grid & Categorization */}
        <section className="flex-1 h-full flex flex-col overflow-hidden min-w-0">
          <ItemGrid
            items={filteredItems}
            selectedCategory={selectedCategory}
            onSelectCategory={setSelectedCategory}
            onAddItem={handleAddItem}
          />
        </section>

        {/* Right Section: Interactive Order Cart */}
        <aside className="w-full lg:w-96 xl:w-[420px] shrink-0 h-full flex flex-col">
          <OrderCart
            orderItems={orderItems}
            customerReference={customerReference}
            onCustomerReferenceChange={setCustomerReference}
            onUpdateQuantity={handleUpdateQuantity}
            onRemoveItem={handleRemoveItem}
            onClearOrder={handleClearOrder}
            onCheckout={handleCheckout}
          />
        </aside>
      </main>

      {/* Modals */}
      <ReceiptModal
        receipt={activeReceipt}
        onClose={() => setActiveReceipt(null)}
      />

      <HistoryModal
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
        transactions={transactions}
        onSelectReceipt={(receipt) => setActiveReceipt(receipt)}
      />

      <CustomItemModal
        isOpen={isCustomItemOpen}
        onClose={() => setIsCustomItemOpen(false)}
        onAddCustomItem={handleAddCustomItem}
      />
    </div>
  );
}
