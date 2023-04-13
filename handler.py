import requests
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.common.keys import Keys

def parseWishlist(event, context):
    print(event)
    print(context)
    wishlist_url = "https://www.amazon.com/hz/wishlist/ls/27RORQ2D4ZEPH?ref_=wl_share"
    
        # Launch a headless Chrome browser
    chrome_options = webdriver.ChromeOptions()
    chrome_options.add_argument('--headless')
    driver = webdriver.Chrome(options=chrome_options)

    driver.get(wishlist_url)

    # Scroll the page down
    driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")


    # Get the entire HTML of the page
    html = driver.page_source

    # Parse the HTML using BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')
    
    list_container = soup.find("ul", id="g-items")
    
    items = list_container.find_all("li", class_="g-item-sortable")
    print(f"Found {len(items)}")
    
    results = []
    for item in items:
        item_id = item['data-itemid']
        item_title = item.find("a", class_="a-link-normal")["title"]
        item_maker = item.find("span", class_="a-size-base").text.replace(" by ", "")
        item_href = item.find("a", class_="a-link-normal")["href"]
        results.append([item_id, item_title, item_maker, item_href])
        # table.add_row([item_id, item_title, item_maker, item_href])
    
    print(f"Found {len(items)}")
    response = {
        "statusCode": 200,
        "body": json.dumps(results)
    }
    return response