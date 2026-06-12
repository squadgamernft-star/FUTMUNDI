#!/bin/bash

# FUTMUNDI - Quick Setup Script
# This script helps you set up FUTMUNDI locally

set -e

echo "🚀 FUTMUNDI Setup Script"
echo "========================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js >= 16"
    exit 1
fi

echo "✅ Node.js $(node --version) found"
echo ""

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed"
    exit 1
fi

echo "✅ npm $(npm --version) found"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
npm install

echo "✅ Dependencies installed"
echo ""

# Create .env.local if it doesn't exist
if [ ! -f .env.local ]; then
    echo "📝 Creating .env.local from .env.example..."
    cp .env.example .env.local
    echo "⚠️  Please update .env.local with your credentials"
else
    echo "✅ .env.local already exists"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "  1. Edit .env.local with your Supabase & TON credentials"
echo "  2. Run 'npm run dev' to start local development"
echo "  3. Visit http://localhost:3000"
echo ""
echo "📚 Documentation: See README.md and IMPROVEMENTS.md"
echo ""
