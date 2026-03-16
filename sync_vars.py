import os
import sys
import requests
import re

def sync_vars(dot_env_path, project_id, token):
    if not os.path.exists(dot_env_path):
        print(f"Error: {dot_env_path} not found")
        return

    with open(dot_env_path, 'r') as f:
        content = f.read()

    # Regex to catch KEY=VALUE, ignoring comments and empty lines
    pattern = re.compile(r'^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$', re.MULTILINE)
    matches = pattern.findall(content)

    api_url = f"https://gitlab.com/api/v4/projects/{project_id}/variables"
    headers = {"PRIVATE-TOKEN": token}

    print(f"Found {len(matches)} variables in {dot_env_path}. Syncing to GitLab...")

    for key, value in matches:
        # Clean up value (remove quotes if present)
        value = value.strip().strip('"').strip("'")
        
        # Decide if it should be masked based on key name AND length (GitLab requires >= 8 chars for masking)
        is_secret_name = any(secret in key.upper() for secret in ['PASS', 'TOKEN', 'KEY', 'URL', 'SECRET', 'ID'])
        masked = is_secret_name and len(value) >= 8
        
        data = {
            "key": key,
            "value": value,
            "masked": masked,
            "protected": False # Set to False for easier dev deployments
        }

        # Try to create, if exists, update
        response = requests.post(api_url, headers=headers, data=data)
        if response.status_code == 201:
            print(f"✅ Created: {key}")
        elif response.status_code == 400: # Probably already exists
            update_url = f"{api_url}/{key}"
            resp_update = requests.put(update_url, headers=headers, data=data)
            if resp_update.status_code == 200:
                print(f"🔄 Updated: {key}")
            else:
                print(f"❌ Failed to update {key}: {resp_update.text}")
        else:
            print(f"❌ Error for {key}: {response.text}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 sync_vars.py <PROJECT_ID> <GITLAB_TOKEN>")
        sys.exit(1)
    
    p_id = sys.argv[1]
    g_token = sys.argv[2]
    sync_vars('.env', p_id, g_token)
