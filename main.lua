local gs = 30
local c = 30
local grid = {}
local win = false
local lose = false
local timeLeft = 60
local statusText = "Waiting for player..."
local ws = nil

function love.load()
    love.window.setTitle("pinksweeper multiplayer")
    love.window.setMode(gs * c, gs * c + 40)
    love.graphics.setBackgroundColor(0.12, 0.05, 0.09)
    
    if websocket and websocket.supported() then
        ws = websocket.new("ws", "localhost:8080")
    end
end

function websocketmessage(msg)
    if msg:find("init") then
        statusText = "Game started!"
    elseif msg:find("timer") then
        local t = msg:gmatch('"timeLeft"%s*:%s*(%d+)')()
        if t then timeLeft = tonumber(t) end
    elseif msg:find("reveal") then
        local rx = tonumber(msg:gmatch('"x"%s*:%s*(%d+)')())
        local ry = tonumber(msg:gmatch('"y"%s*:%s*(%d+)')())
        if rx and ry and grid[rx] and grid[ry] then
            grid[rx][ry].rev = true
        end
    elseif msg:find("gameover") then
        if msg:find("winner") then
            win = true
            statusText = "win yippie - click to restart"
        else
            lose = true
            statusText = "game over - click to restart"
        end
    end
end

function love.mousepressed(x, y, button)
    if lose or win then
        if button == 1 then
            love.event.quit("restart")
        end
        return
    end

    local gx = math.floor(x / c) + 1
    local gy = math.floor(y / c) + 1

    if gx >= 1 and gx <= gs and gy >= 1 and gy <= gs then
        if ws and button == 1 then
            ws:send_utf8_text('{"type":"reveal","x":' .. (gx - 1) .. ',"y":' .. (gy - 1) .. '}')
        end
    end
end

function love.draw()
    for x = 1, gs do
        for y = 1, gs do
            local cell = grid[x] and grid[x][y]
            local px = (x - 1) * c
            local py = (y - 1) * c

            if cell and cell.rev then
                if cell.ismine then
                    love.graphics.setColor(1.0, 0.2, 0.6)
                    love.graphics.rectangle("fill", px + 1, py + 1, c - 2, c - 2, 4, 4)
                else
                    love.graphics.setColor(0.92, 0.78, 0.86)
                    love.graphics.rectangle("fill", px + 1, py + 1, c - 2, c - 2, 4, 4)
                    if cell.am > 0 then
                        love.graphics.setColor(0.38, 0.05, 0.22)
                        love.graphics.print(tostring(cell.am), px + 10, py + 7)
                    end
                end
            else
                love.graphics.setColor(0.35, 0.16, 0.28)
                love.graphics.rectangle("fill", px + 1, py + 1, c - 2, c - 2, 4, 4)
            end
        end
    end

    love.graphics.setColor(1.0, 0.82, 0.94)
    local textY = gs * c + 12
    if lose or win then
        love.graphics.print(statusText, 15, textY)
    else
        love.graphics.print("Time: " .. timeLeft .. "s | " .. statusText, 15, textY)
    end
end