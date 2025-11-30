#!/usr/bin/env python3
"""
Switch trading mode between DEMO and REAL
Usage:
  python scripts/switch_mode.py --mode real
  python scripts/switch_mode.py --mode demo
  python scripts/switch_mode.py --status
  python scripts/switch_mode.py --status --verbose
"""

import json
import sys
import os
from pathlib import Path
from datetime import datetime
import argparse

# Mode state file
MODE_STATE_FILE = Path('data/config/trading_mode.json')
MODE_LOG_FILE = Path('data/logs/mode_changes.log')

def ensure_dirs():
    """Ensure required directories exist"""
    MODE_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    MODE_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

def load_mode_state():
    """Load current mode state"""
    if MODE_STATE_FILE.exists():
        try:
            with open(MODE_STATE_FILE, 'r') as f:
                return json.load(f)
        except json.JSONDecodeError:
            print("❌ Error: Invalid mode state file")
            sys.exit(1)
    return None

def save_mode_state(state):
    """Save mode state"""
    with open(MODE_STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)

def log_change(message):
    """Log mode change"""
    timestamp = datetime.utcnow().isoformat()
    log_line = f"{timestamp} [MODE] {message}\n"
    with open(MODE_LOG_FILE, 'a') as f:
        f.write(log_line)

def get_mode_status():
    """Get current mode status"""
    state = load_mode_state()
    if not state:
        return "❌ No mode state found. Bot may not be initialized."
    
    mode = state.get('mode', 'UNKNOWN')
    last_switched = state.get('lastSwitchTime', 'N/A')
    loss_count = state.get('consecutiveLosses', 0)
    is_locked = state.get('autoSwitchLocked', False)
    
    locked_status = 'Yes' if is_locked else 'No'
    loss_threshold = 3
    
    status_msg = f"""
╔═══════════════════════════════════════════╗
║         TRADING MODE STATUS               ║
╠═══════════════════════════════════════════╣
║ Current Mode:        {mode.upper():^20} ║
║ Last Switched:       {str(last_switched)[:19]:^20} ║
║ Mode Locked:         {locked_status:^20} ║
║ Consecutive Losses:  {loss_count}/{loss_threshold} {' ':^13} ║
╚═══════════════════════════════════════════╝
"""
    return status_msg

def switch_mode(target_mode):
    """Switch mode with confirmation"""
    ensure_dirs()
    
    state = load_mode_state()
    if not state:
        print("❌ No mode state found. Please start the bot first.")
        sys.exit(1)
    
    current_mode = state.get('mode', 'UNKNOWN')
    
    if current_mode == target_mode:
        print(f"⚠️  Already in {target_mode.upper()} mode")
        sys.exit(0)
    
    # Check lock
    locked_until = state.get('lockedUntil')
    if locked_until:
        locked_time = datetime.fromisoformat(locked_until)
        if datetime.utcnow() < locked_time:
            remaining = (locked_time - datetime.utcnow()).total_seconds()
            print(f"🔒 Mode switch locked for {remaining:.0f} more seconds")
            print(f"   (This is to prevent accidental rapid mode switches)")
            sys.exit(1)
    
    # Confirmation for REAL mode
    if target_mode.upper() == 'REAL':
        print("\n" + "="*50)
        print("⚠️  WARNING: You are about to switch to REAL mode!")
        print("="*50)
        print("This will start trading with REAL MONEY on your account.")
        print("\nMake sure:")
        print("  ✓ Account is properly funded")
        print("  ✓ Risk settings are correct")
        print("  ✓ You understand the trading strategy")
        print("\nType 'confirm-real-mode' to proceed:")
        
        confirmation = input("> ").strip()
        if confirmation != 'confirm-real-mode':
            print("❌ Confirmation failed. Mode switch cancelled.")
            sys.exit(1)
    
    # Switch mode
    print(f"\n🔄 Switching from {current_mode.upper()} to {target_mode.upper()}...")
    
    state['mode'] = target_mode.upper()
    state['lastSwitchTime'] = datetime.utcnow().isoformat()
    state['consecutiveLosses'] = 0
    state['autoSwitchLocked'] = False
    state['lockExpiresAt'] = None
    
    save_mode_state(state)
    log_change(f"Switched to {target_mode.upper()} mode (manual)")
    
    print(f"✅ Mode switched to {target_mode.upper()}")
    print(f"   Bot will reconnect to {target_mode.upper()} account on next check")
    print("\n" + get_mode_status())

def show_status(verbose=False):
    """Show current mode status"""
    ensure_dirs()
    print(get_mode_status())
    
    if verbose:
        state = load_mode_state()
        if state:
            print("\n📋 Full State (Verbose):")
            print(json.dumps(state, indent=2))
            
            print("\n📜 Recent Log Entries:")
            if MODE_LOG_FILE.exists():
                with open(MODE_LOG_FILE, 'r') as f:
                    lines = f.readlines()[-10:]  # Last 10 lines
                    for line in lines:
                        print(f"   {line.rstrip()}")

def main():
    parser = argparse.ArgumentParser(
        description='Switch trading mode between DEMO and REAL',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python scripts/switch_mode.py --mode real
  python scripts/switch_mode.py --mode demo
  python scripts/switch_mode.py --status
  python scripts/switch_mode.py --status --verbose
        """
    )
    
    parser.add_argument('--mode', choices=['demo', 'real'], help='Target mode')
    parser.add_argument('--status', action='store_true', help='Show current mode status')
    parser.add_argument('--verbose', action='store_true', help='Verbose output (with --status)')
    
    args = parser.parse_args()
    
    if args.status:
        show_status(verbose=args.verbose)
    elif args.mode:
        switch_mode(args.mode)
    else:
        parser.print_help()

if __name__ == '__main__':
    main()
